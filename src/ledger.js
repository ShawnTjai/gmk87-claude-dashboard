// Persistent per-session usage ledger.
//
// The on-screen "ALL TIME" total must not go backwards. But transcripts live
// under ~/.claude/projects and are owned by Claude Code, which removes them
// (retention cleanup, /clear, deleting a project). A total recomputed live from
// on-disk files therefore drops whenever a session's .jsonl disappears.
//
// The ledger fixes that: it remembers each session's contribution keyed by its
// relative transcript path, and NEVER deletes an entry. Lifetime = sum over all
// remembered sessions, so a deleted transcript keeps counting. Per-file entries
// also carry (mtimeMs, size), so an unchanged file is skipped instead of being
// re-parsed every cycle — which is what kept a single 631MB transcript pinning
// the parse at ~25s. Entries only ever ratchet UP (max-guard), so a compacted /
// truncated transcript can't lower the lifetime figure either.
import { readFile, writeFile, mkdir, rename, stat } from "node:fs/promises";
import path from "node:path";
import { parseTranscript, aggregate, findJsonlFiles, localDayKey } from "./stats.js";

export async function loadLedger(ledgerPath) {
  try {
    const data = JSON.parse(await readFile(ledgerPath, "utf8"));
    if (data && typeof data === "object" && data.sessions && typeof data.sessions === "object") {
      return data;
    }
  } catch { /* missing or corrupt → fresh ledger */ }
  return { sessions: {} };
}

export async function saveLedger(ledgerPath, ledger) {
  await mkdir(path.dirname(ledgerPath), { recursive: true });
  // Write to a temp file then rename so a crash mid-write can't corrupt the
  // ledger (rename is atomic on the same volume).
  const tmp = `${ledgerPath}.tmp`;
  await writeFile(tmp, JSON.stringify(ledger));
  await rename(tmp, ledgerPath);
}

function emptyAgg() {
  return { tokens_in: 0, tokens_out: 0, cache_reads: 0, tokens_total: 0, cost: 0, messages: 0 };
}

function addInto(acc, a) {
  acc.tokens_in    += a.tokens_in    || 0;
  acc.tokens_out   += a.tokens_out   || 0;
  acc.cache_reads  += a.cache_reads  || 0;
  acc.tokens_total += a.tokens_total || 0;
  acc.cost         += a.cost         || 0;
  acc.messages     += a.messages     || 0;
  return acc;
}

function sessionKey(projectsDir, file) {
  return path.relative(projectsDir, file).split(path.sep).join("/");
}

// Walk the projects dir, refresh the ledger from changed/new files, and return
// today + lifetime + byProject in a single pass. `ledger` is mutated in place;
// the caller is responsible for persisting it (so a caller can batch writes).
export async function computeStats(projectsDir, dayKey, ledger) {
  const files = await findJsonlFiles(projectsDir);

  const todayRecords = [];
  const recordsByProject = new Map();   // projectHash -> today records[]
  const sessionFilesToday = new Set();

  for (const file of files) {
    let st;
    try { st = await stat(file); } catch { continue; }
    const key = sessionKey(projectsDir, file);
    const entry = ledger.sessions[key];
    const unchanged = entry && entry.mtimeMs === st.mtimeMs && entry.size === st.size;
    // A file last modified today may hold today's records; it must be parsed even
    // if the ledger already has it, so today/byProject stay live. Old unchanged
    // files (e.g. the 631MB monster, untouched for weeks) are skipped entirely.
    const maybeToday = localDayKey(new Date(st.mtimeMs).toISOString()) === dayKey;

    if (unchanged && !maybeToday) continue;

    const recs = await parseTranscript(file);
    const agg = aggregate(recs);

    // Ratchet up only: never let a shrunk/compacted transcript lower the total.
    if (!entry || agg.tokens_total >= entry.agg.tokens_total) {
      ledger.sessions[key] = { agg, mtimeMs: st.mtimeMs, size: st.size };
    }

    if (maybeToday) {
      const todays = recs.filter((r) => localDayKey(r.timestamp) === dayKey);
      if (todays.length) {
        sessionFilesToday.add(file);
        todayRecords.push(...todays);
        const projectHash = path.basename(path.dirname(file));
        if (!recordsByProject.has(projectHash)) recordsByProject.set(projectHash, []);
        recordsByProject.get(projectHash).push(...todays);
      }
    }
  }

  // Lifetime = every remembered session, including ones whose files are now gone.
  const lifetime = emptyAgg();
  for (const e of Object.values(ledger.sessions)) addInto(lifetime, e.agg);

  const byProject = [...recordsByProject.entries()]
    .map(([projectHash, recs]) => ({ projectHash, ...aggregate(recs) }))
    .sort((a, b) => b.tokens_total - a.tokens_total);

  return {
    today: aggregate(todayRecords),
    lifetime,
    byProject,
    sessionsToday: sessionFilesToday.size,
  };
}
