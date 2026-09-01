import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { loadLedger, saveLedger, computeStats } from "../src/ledger.js";

async function tmpRoot(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

// One assistant row. day = YYYY-MM-DD (local), id must be unique per message.
function row(day, id, model, usage) {
  return JSON.stringify({
    type: "assistant",
    timestamp: `${day}T10:00:00.000Z`,
    message: { id, model, usage },
  }) + "\n";
}

// A transcript that holds a given day's records was, in reality, last written
// that day. computeStats uses file mtime as a fast-path gate for "could this
// file hold today's records?" (it skips parsing old untouched files), so a
// fixture must stamp the file with a matching mtime or the today-branch never
// runs. Local noon keeps the resulting day tz-stable.
async function touchDay(file, day) {
  const t = new Date(`${day}T12:00:00`);
  await fs.utimes(file, t, t);
}

test("loadLedger returns an empty structure for a missing or corrupt file", async () => {
  const root = await tmpRoot("led-load-");
  const p = path.join(root, "ledger.json");
  assert.deepEqual(await loadLedger(p), { sessions: {} });
  await fs.writeFile(p, "not json{{{");
  assert.deepEqual(await loadLedger(p), { sessions: {} });
  await fs.rm(root, { recursive: true, force: true });
});

test("saveLedger round-trips through loadLedger", async () => {
  const root = await tmpRoot("led-save-");
  const p = path.join(root, ".runtime", "ledger.json");
  const led = { sessions: { "a/b.jsonl": { agg: { tokens_total: 42, cost: 1 }, mtimeMs: 5, size: 9 } } };
  await saveLedger(p, led);
  assert.deepEqual(await loadLedger(p), led);
  await fs.rm(root, { recursive: true, force: true });
});

test("computeStats seeds the ledger and sums lifetime across all files", async () => {
  const root = await tmpRoot("led-seed-");
  const day = "2026-08-24";
  await fs.mkdir(path.join(root, "projA"), { recursive: true });
  await fs.mkdir(path.join(root, "projB"), { recursive: true });
  // Sonnet: input $3/M, output $15/M
  await fs.writeFile(path.join(root, "projA", "s1.jsonl"),
    row(day, "m1", "claude-sonnet-4-6", { input_tokens: 1_000_000, output_tokens: 0 }));
  await fs.writeFile(path.join(root, "projB", "s2.jsonl"),
    row("2026-08-01", "m2", "claude-sonnet-4-6", { input_tokens: 2_000_000, output_tokens: 0 }));
  await touchDay(path.join(root, "projA", "s1.jsonl"), day);
  await touchDay(path.join(root, "projB", "s2.jsonl"), "2026-08-01");

  const ledger = { sessions: {} };
  const out = await computeStats(root, day, ledger);
  assert.equal(out.lifetime.tokens_total, 3_000_000);
  assert.equal(out.lifetime.cost, 9); // 3M input @ $3/M
  assert.equal(out.today.tokens_total, 1_000_000); // only s1 is today
  assert.equal(Object.keys(ledger.sessions).length, 2);
  await fs.rm(root, { recursive: true, force: true });
});

test("lifetime is PRESERVED when a transcript file disappears (the core invariant)", async () => {
  const root = await tmpRoot("led-persist-");
  const day = "2026-08-24";
  await fs.mkdir(path.join(root, "projA"), { recursive: true });
  const big = path.join(root, "projA", "big.jsonl");
  const small = path.join(root, "projA", "small.jsonl");
  await fs.writeFile(big, row("2026-07-01", "b1", "claude-sonnet-4-6", { input_tokens: 100_000_000, output_tokens: 0 }));
  await fs.writeFile(small, row(day, "s1", "claude-sonnet-4-6", { input_tokens: 1_000_000, output_tokens: 0 }));

  const ledger = { sessions: {} };
  const first = await computeStats(root, day, ledger);
  assert.equal(first.lifetime.tokens_total, 101_000_000);

  // Claude Code removes the big transcript (retention cleanup / clear / delete project).
  await fs.rm(big);
  const second = await computeStats(root, day, ledger);
  // Without the ledger this would collapse to 1,000,000. With it, history survives.
  assert.equal(second.lifetime.tokens_total, 101_000_000);
  await fs.rm(root, { recursive: true, force: true });
});

test("max-guard: a file that shrinks does not lower its ledger contribution", async () => {
  const root = await tmpRoot("led-maxguard-");
  const day = "2026-08-24";
  await fs.mkdir(path.join(root, "projA"), { recursive: true });
  const f = path.join(root, "projA", "s.jsonl");
  await fs.writeFile(f,
    row(day, "m1", "claude-sonnet-4-6", { input_tokens: 5_000_000, output_tokens: 0 }) +
    row(day, "m2", "claude-sonnet-4-6", { input_tokens: 5_000_000, output_tokens: 0 }));

  const ledger = { sessions: {} };
  const first = await computeStats(root, day, ledger);
  assert.equal(first.lifetime.tokens_total, 10_000_000);

  // File rewritten smaller (e.g. Claude Code compaction). New mtime forces a re-parse.
  await fs.writeFile(f, row(day, "m1", "claude-sonnet-4-6", { input_tokens: 1_000_000, output_tokens: 0 }));
  const future = new Date(Date.now() + 60_000);
  await fs.utimes(f, future, future);
  const second = await computeStats(root, day, ledger);
  assert.equal(second.lifetime.tokens_total, 10_000_000); // kept the higher figure
  await fs.rm(root, { recursive: true, force: true });
});

test("a growing file updates its ledger contribution upward", async () => {
  const root = await tmpRoot("led-grow-");
  const day = "2026-08-24";
  await fs.mkdir(path.join(root, "projA"), { recursive: true });
  const f = path.join(root, "projA", "s.jsonl");
  await fs.writeFile(f, row(day, "m1", "claude-sonnet-4-6", { input_tokens: 1_000_000, output_tokens: 0 }));

  const ledger = { sessions: {} };
  await computeStats(root, day, ledger);

  await fs.appendFile(f, row(day, "m2", "claude-sonnet-4-6", { input_tokens: 4_000_000, output_tokens: 0 }));
  // Growth changes the file size, which forces a re-parse. Stamp mtime to `day`
  // so the record also counts toward that day's total.
  await touchDay(f, day);
  const out = await computeStats(root, day, ledger);
  assert.equal(out.lifetime.tokens_total, 5_000_000);
  assert.equal(out.today.tokens_total, 5_000_000);
  await fs.rm(root, { recursive: true, force: true });
});

test("byProject and sessionsToday reflect only today's activity", async () => {
  const root = await tmpRoot("led-today-");
  const day = "2026-08-24";
  await fs.mkdir(path.join(root, "projA"), { recursive: true });
  await fs.mkdir(path.join(root, "projB"), { recursive: true });
  await fs.writeFile(path.join(root, "projA", "s1.jsonl"),
    row(day, "a1", "claude-sonnet-4-6", { input_tokens: 3_000_000, output_tokens: 0 }));
  await fs.writeFile(path.join(root, "projB", "s2.jsonl"),
    row(day, "b1", "claude-sonnet-4-6", { input_tokens: 1_000_000, output_tokens: 0 }));
  await fs.writeFile(path.join(root, "projB", "old.jsonl"),
    row("2026-08-01", "b0", "claude-sonnet-4-6", { input_tokens: 9_000_000, output_tokens: 0 }));
  await touchDay(path.join(root, "projA", "s1.jsonl"), day);
  await touchDay(path.join(root, "projB", "s2.jsonl"), day);
  await touchDay(path.join(root, "projB", "old.jsonl"), "2026-08-01");

  const out = await computeStats(root, day, { sessions: {} });
  assert.equal(out.sessionsToday, 2);
  assert.equal(out.byProject.length, 2);
  assert.equal(out.byProject[0].projectHash, "projA"); // sorted desc by tokens
  assert.equal(out.byProject[0].tokens_total, 3_000_000);
  await fs.rm(root, { recursive: true, force: true });
});
