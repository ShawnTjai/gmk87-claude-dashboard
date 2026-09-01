import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import fs from "node:fs/promises";
import path from "node:path";
import { ActivityTracker, bucketFor, scanActiveSessions } from "../src/activity.js";

test("bucketFor maps intensity to idle/low/med/hot", () => {
  assert.equal(bucketFor(0),   "idle");
  assert.equal(bucketFor(19),  "idle");
  assert.equal(bucketFor(20),  "low");
  assert.equal(bucketFor(49),  "low");
  assert.equal(bucketFor(50),  "med");
  assert.equal(bucketFor(79),  "med");
  assert.equal(bucketFor(80),  "hot");
  assert.equal(bucketFor(150), "hot"); // clamped
});

test("tool_rate decays toward zero over time", () => {
  let now = 1000;
  const clock = () => now;
  const tracker = new ActivityTracker({ clock });
  tracker.recordToolUse();
  tracker.recordToolUse();
  assert.equal(tracker.toolRate, 2);
  // advance 10s — should halve
  now += 10_000;
  tracker.tick();
  assert.ok(tracker.toolRate > 0.95 && tracker.toolRate < 1.05, `expected ~1.0, got ${tracker.toolRate}`);
  // advance another 10s — should halve again
  now += 10_000;
  tracker.tick();
  assert.ok(tracker.toolRate > 0.45 && tracker.toolRate < 0.55, `expected ~0.5, got ${tracker.toolRate}`);
});

test("intensity combines sessions and tool rate", () => {
  const tracker = new ActivityTracker({ clock: () => 0 });
  tracker.setSessionCount(2);
  tracker.recordToolUse();
  tracker.recordToolUse();
  // 2 * 30 + 2 * 15 = 90
  assert.equal(tracker.intensity, 90);
  assert.equal(tracker.bucket, "hot");
});

test("intensity is clamped to 100", () => {
  const tracker = new ActivityTracker({ clock: () => 0 });
  tracker.setSessionCount(10);
  for (let i = 0; i < 50; i++) tracker.recordToolUse();
  assert.equal(tracker.intensity, 100);
});

test("scanActiveSessions counts .jsonl files modified within window", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "act-"));
  await fs.mkdir(path.join(root, "p1"), { recursive: true });
  await fs.writeFile(path.join(root, "p1", "active1.jsonl"), "x");
  await fs.writeFile(path.join(root, "p1", "active2.jsonl"), "x");
  const stale = path.join(root, "p1", "stale.jsonl");
  await fs.writeFile(stale, "x");
  // Backdate stale to 60s ago
  const past = new Date(Date.now() - 60_000);
  await fs.utimes(stale, past, past);
  const n = await scanActiveSessions(root, 15_000);
  assert.equal(n, 2);
  await fs.rm(root, { recursive: true, force: true });
});
