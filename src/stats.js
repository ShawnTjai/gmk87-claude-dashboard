import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { costForMessage } from "./rates.js";

export async function parseTranscript(filePath) {
  // Assistant messages are streamed across multiple rows (thinking, text, tool_use),
  // all sharing the same message.id and the same usage totals. We must dedupe.
  const seen = new Map(); // message.id -> record
  const stream = createReadStream(filePath, { encoding: "utf8" });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (row.type !== "assistant") continue;
    if (!row.message || !row.message.usage) continue;
    if (typeof row.timestamp !== "string") continue;
    const id = row.message.id;
    if (id && seen.has(id)) continue;
    const record = {
      id,
      model: row.message.model || "unknown",
      usage: row.message.usage,
      timestamp: row.timestamp,
    };
    if (id) seen.set(id, record);
    else seen.set(`anon-${seen.size}`, record);
  }
  return [...seen.values()];
}

// Convert an ISO UTC timestamp to a YYYY-MM-DD string in the *local* timezone.
// Required because transcript timestamps are UTC but todayKey() is local —
// without this, records made early-morning local time (which are still
// "yesterday" in UTC) get filtered out of "today"'s aggregation.
export function localDayKey(isoTimestamp) {
  const d = new Date(isoTimestamp);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

export async function parseTranscriptForDay(filePath, dayKey) {
  const all = await parseTranscript(filePath);
  return all.filter((r) => localDayKey(r.timestamp) === dayKey);
}

export function aggregate(records) {
  // Headline `tokens_total` matches Anthropic's billing-dashboard convention:
  //   input + cache_creation + output
  // Cache reads (re-reading existing cache on every turn) are excluded —
  // they otherwise dominate by 10× and obscure the more meaningful numbers.
  // The cost calculation in rates.js still bills cache reads correctly at 0.1× input.
  let tokens_in = 0;
  let tokens_out = 0;
  let cache_reads = 0; // tracked separately for diagnostics; not in tokens_total
  let cost = 0;
  for (const r of records) {
    const u = r.usage || {};
    tokens_in  += (u.input_tokens                 || 0)
                + (u.cache_creation_input_tokens  || 0);
    tokens_out += (u.output_tokens                || 0);
    cache_reads += (u.cache_read_input_tokens     || 0);
    cost       += costForMessage(r.model, u);
  }
  return {
    tokens_in,
    tokens_out,
    cache_reads,
    tokens_total: tokens_in + tokens_out,
    cost,
    messages: records.length, // unique assistant messages (deduped by id)
  };
}

export function todayKey(date = new Date()) {
  // Local date as YYYY-MM-DD
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export async function findJsonlFiles(dir) {
  const out = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await findJsonlFiles(full)));
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      out.push(full);
    }
  }
  return out;
}

export async function aggregateToday(projectsDir, dayKey) {
  const files = await findJsonlFiles(projectsDir);
  const allRecords = [];
  for (const f of files) {
    const recs = await parseTranscriptForDay(f, dayKey);
    allRecords.push(...recs);
  }
  return aggregate(allRecords);
}

// Walks the projects directory once and returns both today's and
// all-time totals from the same set of parsed records. Also breaks today's
// usage down by project hash (parent dir name encodes the working dir),
// and counts how many distinct session files had any activity today.
export async function aggregateBoth(projectsDir, dayKey) {
  const files = await findJsonlFiles(projectsDir);
  const allRecords = [];
  const recordsByProject = new Map();   // projectHash -> records[] (today only)
  const sessionFilesToday = new Set();  // distinct .jsonl files that had any record today

  for (const f of files) {
    const projectHash = path.basename(path.dirname(f));
    const recs = await parseTranscript(f);
    allRecords.push(...recs);

    const todayRecs = recs.filter((r) => localDayKey(r.timestamp) === dayKey);
    if (todayRecs.length === 0) continue;
    sessionFilesToday.add(f);
    if (!recordsByProject.has(projectHash)) recordsByProject.set(projectHash, []);
    recordsByProject.get(projectHash).push(...todayRecs);
  }

  const todayRecords = allRecords.filter((r) => localDayKey(r.timestamp) === dayKey);

  const byProject = [...recordsByProject.entries()]
    .map(([projectHash, recs]) => ({ projectHash, ...aggregate(recs) }))
    .sort((a, b) => b.tokens_total - a.tokens_total);

  return {
    today: aggregate(todayRecords),
    lifetime: aggregate(allRecords),
    byProject,                            // sorted desc by tokens_total
    sessionsToday: sessionFilesToday.size,
  };
}
