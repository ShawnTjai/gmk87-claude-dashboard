import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parseTranscriptForDay, aggregate, aggregateToday, aggregateBoth } from "../src/stats.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(__dirname, "fixtures/sample-sonnet.jsonl");
const dayKey = "2026-06-02"; // matches the recent rows in the fixture

test("parseTranscriptForDay extracts unique assistant messages for the day (dedupes by message.id)", async () => {
  const records = await parseTranscriptForDay(fixture, dayKey);
  // Fixture has msg_1 streamed across 3 rows + msg_2 once + msg_old (different day).
  // Expected: msg_1 counted once, msg_2 counted once → 2 unique records.
  assert.equal(records.length, 2);
  assert.equal(records[0].model, "claude-sonnet-4-6");
  assert.equal(records[0].usage.input_tokens, 100);
  assert.equal(records[1].usage.input_tokens, 150);
});

test("parseTranscriptForDay skips lines that fail to parse without throwing", async () => {
  const tmp = path.join(__dirname, "fixtures/corrupt.jsonl");
  const fs = await import("node:fs/promises");
  await fs.writeFile(tmp, [
    "this is not json",
    '{"type":"assistant","timestamp":"2026-06-02T10:00:00.000Z","message":{"model":"claude-sonnet-4-6","usage":{"input_tokens":42}}}',
    "",
  ].join("\n"));
  const records = await parseTranscriptForDay(tmp, dayKey);
  assert.equal(records.length, 1);
  await fs.unlink(tmp);
});

test("aggregate sums tokens and cost across records", () => {
  const records = [
    { model: "claude-sonnet-4-6", usage: { input_tokens: 1_000_000, output_tokens: 1_000_000 } },
    { model: "claude-haiku-4-5",  usage: { input_tokens: 2_000_000, output_tokens: 0          } },
  ];
  const out = aggregate(records);
  // Sonnet: 1M * 3 + 1M * 15 = 18; Haiku: 2M * 1 = 2 → $20 total
  assert.equal(out.cost, 20);
  // tokens_in counts input + cache_creation (NOT cache_read) = 1M + 2M = 3M
  assert.equal(out.tokens_in, 3_000_000);
  assert.equal(out.tokens_out, 1_000_000);
  assert.equal(out.tokens_total, 4_000_000);
  assert.equal(out.cache_reads, 0);
});

test("aggregate tracks cache_reads separately and bills them via cost", () => {
  // Sonnet, 1M cache_read tokens only.
  // Cache read rate: $0.30/M → cost = $0.30
  // tokens_total should NOT include cache_read.
  const out = aggregate([
    { model: "claude-sonnet-4-6", usage: { cache_read_input_tokens: 1_000_000 } },
  ]);
  assert.equal(out.tokens_in, 0);
  assert.equal(out.tokens_out, 0);
  assert.equal(out.tokens_total, 0);
  assert.equal(out.cache_reads, 1_000_000);
  assert.equal(out.cost, 0.30);
});

test("aggregateToday walks a directory tree and sums all matching transcripts", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cstd-"));
  await fs.mkdir(path.join(root, "projA"), { recursive: true });
  await fs.mkdir(path.join(root, "projB"), { recursive: true });
  const day = "2026-06-02";
  const line = (n) =>
    `{"type":"assistant","timestamp":"${day}T10:00:00.000Z","message":{"model":"claude-sonnet-4-6","usage":{"input_tokens":${n},"output_tokens":0}}}\n`;
  await fs.writeFile(path.join(root, "projA", "s1.jsonl"), line(1_000_000));
  await fs.writeFile(path.join(root, "projB", "s2.jsonl"), line(2_000_000));
  await fs.writeFile(path.join(root, "projB", "s3.jsonl"), line(3_000_000));
  const out = await aggregateToday(root, day);
  // Total = 6M input tokens, all Sonnet @ $3/M = $18
  assert.equal(out.tokens_total, 6_000_000);
  assert.equal(out.cost, 18);
  await fs.rm(root, { recursive: true, force: true });
});

test("aggregateBoth returns today and lifetime totals in one walk", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cstd-both-"));
  await fs.mkdir(path.join(root, "projA"), { recursive: true });
  const today = "2026-06-02";
  const lineFor = (day, id, n) =>
    `{"type":"assistant","timestamp":"${day}T10:00:00.000Z","message":{"id":"${id}","model":"claude-sonnet-4-6","usage":{"input_tokens":${n},"output_tokens":0}}}\n`;
  // 2 messages today (1M + 2M = 3M), 1 message yesterday (5M)
  await fs.writeFile(
    path.join(root, "projA", "s1.jsonl"),
    lineFor(today, "m1", 1_000_000) +
      lineFor(today, "m2", 2_000_000) +
      lineFor("2026-06-01", "m3", 5_000_000),
  );
  const out = await aggregateBoth(root, today);
  // Today: 3M Sonnet @ $3/M = $9
  assert.equal(out.today.tokens_total, 3_000_000);
  assert.equal(out.today.cost, 9);
  // Lifetime: 8M Sonnet @ $3/M = $24
  assert.equal(out.lifetime.tokens_total, 8_000_000);
  assert.equal(out.lifetime.cost, 24);
  await fs.rm(root, { recursive: true, force: true });
});
