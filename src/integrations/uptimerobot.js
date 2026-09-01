/**
 * UptimeRobot integration — lists all monitors and surfaces which (if any)
 * are currently down. Used both as a regular slideshow slide (when all green)
 * and as a priority interrupt slide (when anything is down).
 *
 * Status codes (UptimeRobot v2 API):
 *   0 = paused, 1 = not checked yet, 2 = up, 8 = seems down, 9 = down
 *
 * We treat status 8 or 9 as DOWN. Paused (0) and not-yet-checked (1) are
 * ignored — they're not "real" outages.
 *
 * Public API:
 *   fetchMonitors({ force? }) → {
 *     totalCount, upCount, downCount, pausedCount,
 *     monitors: [{ id, name, url, status, isDown, downSinceMs, downForSeconds }],
 *     downServices: filtered subset where isDown,
 *     fetchedAt, staleness, error?,
 *   }
 */

import { readFile } from "node:fs/promises";
import path from "node:path";

const CONFIG_PATH = path.resolve("uptimerobot.config.json");
const CACHE_TTL_MS = 30_000; // 30s — fast enough to catch outages within a slide cycle

let cached = null;
let cachedAt = 0;

async function loadConfig() {
  return JSON.parse(await readFile(CONFIG_PATH, "utf8"));
}

export async function fetchMonitors({ force = false } = {}) {
  if (!force && cached && Date.now() - cachedAt < CACHE_TTL_MS) {
    return { ...cached, staleness: "cached" };
  }

  try {
    const cfg = await loadConfig();
    const body = new URLSearchParams({
      api_key: cfg.apiKey,
      format: "json",
      // logs=1 gives us the most recent down/up log per monitor, which is how
      // we derive "down since" — that's the timestamp of the latest "down" event.
      logs: "1",
      logs_limit: "5",
    });
    const r = await fetch("https://api.uptimerobot.com/v2/getMonitors", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "cache-control": "no-cache" },
      body: body.toString(),
    });
    const j = await r.json();
    if (j.stat !== "ok") throw new Error(`uptimerobot: ${j.error?.message || j.stat}`);

    const now = Date.now();
    const monitors = (j.monitors || []).map((m) => {
      const isDown = m.status === 8 || m.status === 9;
      // Find the most recent log of type=1 (down). UptimeRobot log type 1 = down, 2 = up, 98 = started, 99 = paused.
      let downSinceMs = null;
      if (isDown && Array.isArray(m.logs)) {
        const downLog = m.logs.find((l) => l.type === 1);
        if (downLog && downLog.datetime) downSinceMs = downLog.datetime * 1000;
      }
      return {
        id: m.id,
        name: m.friendly_name || m.url || `monitor #${m.id}`,
        url: m.url || "",
        status: m.status,
        isDown,
        downSinceMs,
        downForSeconds: downSinceMs ? Math.max(0, Math.floor((now - downSinceMs) / 1000)) : null,
      };
    });

    const upCount     = monitors.filter((m) => m.status === 2).length;
    const downCount   = monitors.filter((m) => m.isDown).length;
    const pausedCount = monitors.filter((m) => m.status === 0).length;
    const downServices = monitors.filter((m) => m.isDown).sort((a, b) => {
      // Longest-down first — that's the most urgent
      const ad = a.downForSeconds ?? 0;
      const bd = b.downForSeconds ?? 0;
      return bd - ad;
    });

    cached = {
      totalCount: monitors.length,
      upCount, downCount, pausedCount,
      monitors,
      downServices,
      fetchedAt: now,
      staleness: "fresh",
    };
    cachedAt = now;
    return cached;
  } catch (err) {
    if (cached) return { ...cached, staleness: "error-cached", error: err.message };
    return {
      totalCount: 0, upCount: 0, downCount: 0, pausedCount: 0,
      monitors: [], downServices: [],
      fetchedAt: Date.now(), staleness: "error", error: err.message,
    };
  }
}
