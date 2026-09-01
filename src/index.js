import path from "node:path";
import os from "node:os";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import chokidar from "chokidar";
import { todayKey } from "./stats.js";
import { loadLedger, saveLedger, computeStats } from "./ledger.js";
import { ActivityTracker, scanActiveSessions } from "./activity.js";
import { uploadSlots, showSlot, getCurrentDisplaySlot, revertToTime } from "./uploader.js";
import { startHookServer } from "./hook-server.js";
import { fetchUsage, extractBars } from "./usage-api.js";
import { PINNED_VIEW, SLIDESHOW_VIEWS, SLIDESHOW_INTERVAL_MS } from "./views/index.js";
import { fetchPipelineActivity as fetchGitlabPipelines } from "./integrations/gitlab.js";
import { fetchPipelineActivity as fetchGithubPipelines } from "./integrations/github.js";
import { fetchMonitors as fetchUptimeRobot } from "./integrations/uptimerobot.js";
import { fetchUsage as fetchAzureUsage } from "./integrations/azure.js";
import { fetchOverview as fetchCloudflareOverview } from "./integrations/cloudflare.js";
import { setLockedLed, setOutageUnderglow, captureUnderglowBaseline } from "./lighting-indicator.js";
import { uIOhook } from "uiohook-napi";

// GMK87 knob: rotation maps to Vol+/Vol- via VIA (the OS handles those).
// Only the knob CLICK is remapped to F23 (libuiohook keycode 106) so the
// daemon can intercept it for slide-lock without affecting media keys.
const KEY_KNOB_PRESS = 106;

const PROJECTS_DIR = path.join(os.homedir(), ".claude", "projects");
const RUNTIME_DIR  = path.resolve(".runtime");
const PORT_FILE    = path.join(RUNTIME_DIR, "port");
const LEDGER_FILE  = path.join(RUNTIME_DIR, "ledger.json");
// A Claude Code session can go 60-90s between transcript writes during a
// user-thinking pause (between assistant turns). 90s window catches "I have
// 2 windows open but only one is actively replying right now".
const SESSION_WINDOW_MS = 90_000;

function pad(n) { return String(n).padStart(2, "0"); }
function nowLabel() {
  const d = new Date();
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

async function getPreferredPort() {
  try {
    const txt = await readFile(PORT_FILE, "utf8");
    const n = parseInt(txt, 10);
    return Number.isFinite(n) ? n : 8787;
  } catch {
    return 8787;
  }
}

async function persistPort(port) {
  await mkdir(RUNTIME_DIR, { recursive: true });
  await writeFile(PORT_FILE, String(port));
}

// Fail fast when something genuinely broken happens — Task Scheduler will
// restart us with a clean slate (fresh HID handles, no zombie timers). This
// is the more reliable recovery path than trying to patch up live state.
//
// CRITICAL: death must be UNCONDITIONAL and IMMEDIATE. We get here precisely
// when an HID operation has wedged (the stall watchdog fires on a stuck
// upload/read), and process.exit() hangs in teardown waiting on that stuck
// native node-hid handle. The hung process then survives as a zombie holding
// the HID device + the daemon.log handle open, which silently defeats every
// restart path (the relaunch can't truncate the locked log). That is exactly
// what stranded the daemon for 3 days starting 2026-06-14.
//
// So force OS-level termination instead of process.exit(): SIGKILL maps to
// TerminateProcess on Windows and reaps every thread and wedged handle at once.
// We do NOT call uIOhook.stop() first — stop() joins the native hook thread and
// can itself block, which would prevent the kill from ever running.
function fatal(reason, err) {
  console.error(`[daemon] fatal: ${reason}`, err?.stack || err);
  process.kill(process.pid, "SIGKILL");
}
process.on("unhandledRejection", (err) => fatal("unhandledRejection", err));
process.on("uncaughtException",  (err) => fatal("uncaughtException", err));

async function main() {
  console.log("[daemon] starting");

  const tracker = new ActivityTracker();
  const preferredPort = await getPreferredPort();
  const server = await startHookServer({
    preferredPort,
    onEvent: (type) => {
      if (type === "tool") tracker.recordToolUse();
    },
  });
  const port = server.address().port;
  await persistPort(port);
  console.log(`[daemon] hook server on http://127.0.0.1:${port}`);

  // Refresh whenever a transcript changes — debounced.
  let dirty = true;
  const watcher = chokidar.watch(PROJECTS_DIR, {
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
  });
  watcher.on("all", () => { dirty = true; });

  // Durable per-session usage ledger — makes the "ALL TIME" total survive
  // Claude Code deleting old transcripts (it otherwise recomputes live from
  // on-disk files and drops whenever a session's .jsonl is cleaned up).
  const ledger = await loadLedger(LEDGER_FILE);

  let cachedStats = null;
  let isParsing = false;
  let isUsingHid = false;
  let lastParse = 0;
  const PARSE_INTERVAL_MS = 30_000;

  // Slot 0 is pinned to PINNED_VIEW (Claude Code Usage).
  // Slot 1 cycles through SLIDESHOW_VIEWS. Both slots are re-uploaded
  // together every SLIDESHOW_INTERVAL_MS so they always stay in sync.
  let slideIndex = 0;
  let lastSlideAt = 0;
  let bootstrapped = false;
  // Cache the most recently rendered slot 0 GIF. Slot 0's content depends only
  // on stats + clock, not on slideIndex — so on knob navigation we can re-use
  // the cached buffer and skip the expensive render. Sig is a fingerprint of
  // the inputs that actually affect slot 0's visuals.
  let slot0Cache = { sig: "", buffer: null };
  function slot0Signature(state) {
    return [state.tokensTotal, state.cost.toFixed(2), state.lifetimeTokens,
            state.lifetimeCost.toFixed(2), state.fiveHourPct, state.sevenDayPct,
            state.intensity, state.nowLabel].join("|");
  }
  // Knob control state. `paused` freezes auto-advance (slide stays put, data
  // still refreshes). `forceRender` short-circuits the auto-advance timer so
  // a knob press updates the lock indicator on the next tick.
  // `lastRenderedIdx` tracks which slide is currently visible to the user
  // (slideIndex always points to the NEXT slide to render, so on pause we
  // roll back to lastRenderedIdx to lock the slide they were looking at).
  let paused = false;
  let forceRender = false;
  let lastRenderedIdx = -1;

  // Background parse — only locks itself, NOT the HID device. The ledger's
  // mtime cache means only new/changed transcripts are parsed each cycle (an
  // unchanged multi-hundred-MB file is skipped), so this is far lighter than
  // the old full re-parse. Other operations (upload, ping) run concurrently
  // against the HID. The first cycle after boot still parses everything once
  // to seed the ledger.
  async function maybeReparse() {
    if (isParsing) return;
    const stale = Date.now() - lastParse >= PARSE_INTERVAL_MS;
    if (!stale && !((!cachedStats || dirty) && Date.now() - lastParse >= 5_000)) return;
    isParsing = true;
    try {
      cachedStats = await computeStats(PROJECTS_DIR, todayKey(), ledger);
      await saveLedger(LEDGER_FILE, ledger);
      lastParse = Date.now();
      dirty = false;
    } catch (err) {
      console.error("[daemon] parse error:", err.message);
    } finally {
      isParsing = false;
    }
  }

  // Build the unified state passed to every view. Views ignore fields they
  // don't care about. Centralising this means adding a new metric only
  // touches one place.
  async function buildState() {
    let fiveHourPct = null, sevenDayPct = null;
    try {
      const usage = await fetchUsage();
      ({ fiveHourPct, sevenDayPct } = extractBars(usage));
    } catch (e) { /* usage-api logs its own errors */ }

    tracker.tick();
    const sessions = await scanActiveSessions(PROJECTS_DIR, SESSION_WINDOW_MS);
    tracker.setSessionCount(sessions);

    return {
      paused,
      tokensTotal: cachedStats.today.tokens_total,
      cost: cachedStats.today.cost,
      lifetimeTokens: cachedStats.lifetime.tokens_total,
      lifetimeCost: cachedStats.lifetime.cost,
      messages: cachedStats.today.messages,
      sessions,
      intensity: tracker.intensity,
      bucket: tracker.bucket,
      nowLabel: nowLabel(),
      fiveHourPct,
      sevenDayPct,
      byProject: cachedStats.byProject || [],
      sessionsToday: cachedStats.sessionsToday || 0,
    };
  }

  async function refreshLoop() {
    maybeReparse();
    if (isUsingHid) return;
    if (!cachedStats) return;

    const now = Date.now();
    // We re-render every SLIDESHOW_INTERVAL_MS regardless of pause state so
    // the data on the current slide stays fresh. Pause only suppresses the
    // post-render slideIndex advance (see further down).
    const due = forceRender || now - lastSlideAt >= SLIDESHOW_INTERVAL_MS;
    if (bootstrapped && !due) return;
    forceRender = false;

    isUsingHid = true;
    try {
      const tStart = Date.now();
      const state = await buildState();
      const tState = Date.now();

      // Slot 1 view selection. Two-stage:
      //   1. Priority override: if any view's priority(state) returns true,
      //      pin it (e.g., uptimerobot pins on outage). slideIndex is not
      //      advanced while a priority is active so we resume cleanly.
      //   2. Normal rotation: walk forward from slideIndex, skipping any
      //      view whose shouldShow(state) returns false. Bounded to one
      //      full lap so we never loop forever if everything opts out.
      let priorityIdx = null;
      for (let i = 0; i < SLIDESHOW_VIEWS.length; i++) {
        const v = SLIDESHOW_VIEWS[i];
        if (typeof v.priority !== "function") continue;
        try {
          if (await v.priority(state)) { priorityIdx = i; break; }
        } catch (err) {
          console.warn(`[daemon] ${v.id}.priority threw:`, err.message);
        }
      }

      let probedIdx;
      let slideView;
      if (priorityIdx !== null) {
        probedIdx = priorityIdx;
        slideView = SLIDESHOW_VIEWS[priorityIdx];
      } else {
        probedIdx = slideIndex;
        slideView = SLIDESHOW_VIEWS[probedIdx];
        for (let probe = 0; probe < SLIDESHOW_VIEWS.length; probe++) {
          if (typeof slideView.shouldShow === "function") {
            try {
              if (await slideView.shouldShow(state)) break;
            } catch (err) {
              console.warn(`[daemon] ${slideView.id}.shouldShow threw, treating as visible:`, err.message);
              break;
            }
          } else {
            break;
          }
          probedIdx = (probedIdx + 1) % SLIDESHOW_VIEWS.length;
          slideView = SLIDESHOW_VIEWS[probedIdx];
        }
        slideIndex = probedIdx;
      }

      // Slot 0 = pinned CLAUDE CODE USAGE. Re-use the cached buffer when its
      // input signature hasn't changed (which it usually hasn't between knob
      // ticks). Render slot 0 (if needed) and slot 1 in parallel — they have
      // no dependency on each other and each takes ~100ms+.
      const sig = slot0Signature(state);
      const slot0State = { ...state, paused: false }; // slot 0 never shows the lock indicator
      const slot0Promise = slot0Cache.sig === sig && slot0Cache.buffer
        ? Promise.resolve(slot0Cache.buffer)
        : PINNED_VIEW.render(slot0State).then((buf) => { slot0Cache = { sig, buffer: buf }; return buf; });
      const slot1Promise = slideView.render(state);
      const [slot0Gif, slot1Gif] = await Promise.all([slot0Promise, slot1Promise]);
      const tRender = Date.now();

      let showSlotValue;
      if (!bootstrapped) {
        showSlotValue = 1; // first boot: land on slot 0 (CC pinned)
      } else {
        try {
          showSlotValue = await getCurrentDisplaySlot();
        } catch (err) {
          console.warn("[daemon] couldn't read display slot, defaulting to 1:", err.message);
          showSlotValue = 1;
        }
      }

      await uploadSlots({
        slot0Buffer: slot0Gif,
        slot1Buffer: slot1Gif,
        showSlot: showSlotValue,
      });
      const tUpload = Date.now();

      lastSlideAt = Date.now();
      lastRenderedIdx = probedIdx;
      console.log(
        `[daemon] slot1=${slideView.id} ` +
        `(${slideIndex + 1}/${SLIDESHOW_VIEWS.length}) ` +
        `state=${tState - tStart}ms render=${tRender - tState}ms upload=${tUpload - tRender}ms ` +
        `${slot0Cache.sig === sig ? "(slot0 cached)" : ""} ` +
        `${paused ? "[PAUSED]" : ""}`
      );

      // Advance the rotation only on AUTO ticks. Skip when:
      //   - a priority alert is pinning the view (we want to resume cleanly)
      //   - the user has paused via knob press (current slide stays locked)
      if (priorityIdx === null && !paused) {
        slideIndex = (slideIndex + 1) % SLIDESHOW_VIEWS.length;
      }
      if (!bootstrapped) {
        bootstrapped = true;
        console.log(`[daemon] bootstrap done. slot0 pinned to ${PINNED_VIEW.id}; slot1 cycles ${SLIDESHOW_VIEWS.length} views every ${SLIDESHOW_INTERVAL_MS / 1000}s`);
      }
    } catch (err) {
      console.error("[daemon] refresh error:", err.message);
    } finally {
      isUsingHid = false;
    }

    // If a knob event fired DURING the render we just finished, slideIndex
    // is already updated and forceRender is set — chain another refresh
    // immediately so rapid knob spins feel responsive instead of buffered.
    if (forceRender) setImmediate(() => refreshLoop().catch((e) => console.error("[daemon] chained refresh:", e.message)));
  }

  const interval = setInterval(refreshLoop, 1000);
  await refreshLoop();

  // Stall watchdog. If refreshLoop hasn't completed a successful upload in
  // STALL_TIMEOUT_MS we assume the HID stack is stuck (USB device reset
  // after sleep, gmk87-node holding a dead handle, etc.) and exit so Task
  // Scheduler's restart-on-failure brings us back with a fresh process.
  const STALL_TIMEOUT_MS = 60_000;
  const watchdog = setInterval(() => {
    if (!bootstrapped) return;
    const sinceLast = Date.now() - lastSlideAt;
    if (sinceLast > STALL_TIMEOUT_MS) {
      fatal(`refresh stalled — no successful upload in ${Math.round(sinceLast / 1000)}s`);
    }
  }, 5_000);

  // Background pre-warmers — keep every integration's cache fresh so render
  // path never blocks on network. Each interval is set just under the
  // integration's own TTL so a render lookup always finds warm data.
  // Runs outside the HID lock so it can't stall the slideshow.
  const warmTargets = [
    // Anthropic OAuth usage endpoint is hard-limited to ~1 call/hour. Warm
    // every 55 min so we refresh just before the 60-min cache expires, but
    // never burn through the rate limit.
    { name: "anthropic",  fn: fetchUsage,               intervalMs: 55 * 60_000 }, // TTL 60min
    { name: "gitlab",     fn: fetchGitlabPipelines,     intervalMs:  50_000 },  // TTL  60s
    { name: "github",     fn: fetchGithubPipelines,     intervalMs:  50_000 },  // TTL  60s
    { name: "uptimerobot",fn: fetchUptimeRobot,         intervalMs:  25_000 },  // TTL  30s
    { name: "cloudflare", fn: fetchCloudflareOverview,  intervalMs: 4 * 60_000 }, // TTL 5min
    { name: "azure",      fn: fetchAzureUsage,          intervalMs: 25 * 60_000 }, // TTL 30min
  ];
  function warm(t) {
    return t.fn({ force: true }).catch((e) => console.warn(`[daemon] ${t.name} warm:`, e.message));
  }
  // Initial parallel warmup so first slideshow ticks read entirely from cache.
  Promise.all(warmTargets.map(warm));
  const warmerIntervals = warmTargets.map((t) => setInterval(() => warm(t), t.intervalMs));

  // GMK87 knob → slideshow control. F22/F23/F24 are remapped on the keyboard
  // via VIA. We listen globally (uiohook) because Windows holds the keyboard
  // HID interface exclusively. We only react to these three rare F-keys;
  // every other keypress passes through untouched.
  // Each HID upload to the GMK87 takes ~5–6 seconds (128 KB at ~22 KB/s on
  // the keyboard's USB endpoint — protocol-level constraint, both slots must
  // be uploaded together). Without debounce, every knob detent triggers its
  // own 5s upload, so a 4-click spin takes 20+ seconds to settle on the
  // intended slide. Debouncing batches a fast spin into one upload that
  // renders whatever slideIndex landed on after the user stopped turning.
  const KNOB_DEBOUNCE_MS = 200;
  let knobDebounceTimer = null;
  function scheduleKnobRefresh() {
    if (knobDebounceTimer) clearTimeout(knobDebounceTimer);
    knobDebounceTimer = setTimeout(() => {
      knobDebounceTimer = null;
      // If a refresh is in flight, refreshLoop's finally block already
      // chains another via the forceRender check — so we can just fire.
      refreshLoop().catch((e) => console.error("[daemon] knob refresh:", e.message));
    }, KNOB_DEBOUNCE_MS);
  }
  uIOhook.on("keydown", (e) => {
    if (e.keycode === KEY_KNOB_PRESS) {
      paused = !paused;
      // On lock: roll slideIndex back to whatever the user is currently
      // looking at, so the upcoming forced re-render shows THAT slide with
      // the lock icon — not the next-in-queue one.
      if (paused && lastRenderedIdx >= 0) {
        slideIndex = lastRenderedIdx;
      }
      forceRender = true;
      console.log(`[daemon] knob press → ${paused ? "LOCKED" : "RESUMED"}`);
      // Fire the LED change immediately for instant feedback (~100ms vs the
      // ~5 s image upload it would take for the header to re-render).
      setLockedLed(paused);
      scheduleKnobRefresh();
    }
  });
  uIOhook.start();
  // Capture the user's current underglow setting so we can restore it after
  // an outage. Must come before any setLighting overrides we issue below.
  await captureUnderglowBaseline();
  // Initialize the LED to AUTO state on boot.
  setLockedLed(false);

  // Poll uptimerobot for outage state and drive the underglow accordingly.
  // Uses the integration's existing 30s cache, so this is cheap to call often.
  async function pollOutageStatus() {
    try {
      const data = await fetchUptimeRobot();
      await setOutageUnderglow(data.downCount > 0);
    } catch (e) { /* warmer will log */ }
  }
  pollOutageStatus();
  const outagePoller = setInterval(pollOutageStatus, 10_000);

  async function shutdown(signal) {
    console.log(`[daemon] ${signal} — shutting down`);
    clearInterval(interval);
    clearInterval(watchdog);
    clearInterval(outagePoller);
    for (const w of warmerIntervals) clearInterval(w);
    try { uIOhook.stop(); } catch {}
    // Restore LED to AUTO and underglow to the user's baseline so we don't
    // leave the keyboard stuck in alert/lock state after daemon exits.
    try { await setLockedLed(false); } catch {}
    try { await setOutageUnderglow(false); } catch {}
    await watcher.close();
    try { await revertToTime(); } catch (e) { console.error("[daemon] revertToTime failed:", e.message); }
    await server.closeAsync();
    process.exit(0);
  }
  process.on("SIGINT",  () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => fatal("main", err));
