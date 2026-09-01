import { test } from "node:test";
import assert from "node:assert/strict";
import { formatTokens, frameSvg, svgToStaticGif } from "../src/views/_shared.js";
import claudeUsage from "../src/views/claude-usage.js";
import codingActivity from "../src/views/coding-activity.js";
import gitlabActive from "../src/views/gitlab-active.js";
import gitlabRecentDefault from "../src/views/gitlab-recent.js";
import githubActive from "../src/views/github-active.js";
import githubRecentDefault from "../src/views/github-recent.js";
import uptimerobot from "../src/views/uptimerobot.js";

test("formatTokens compacts large numbers", () => {
  assert.equal(formatTokens(0), "0");
  assert.equal(formatTokens(999), "999");
  assert.equal(formatTokens(1500), "1.5K");
  assert.equal(formatTokens(2_400_000), "2.4M");
  assert.equal(formatTokens(1_234_567_890), "1.2B");
});

test("frameSvg wraps body in a 240x135 svg shell", () => {
  const svg = frameSvg("<text>hello</text>");
  assert.match(svg, /viewBox="0 0 240 135"/);
  assert.match(svg, /<text>hello<\/text>/);
});

test("svgToStaticGif returns a single-frame 240x135 GIF buffer", async () => {
  const svg = frameSvg(`<text x="120" y="60" text-anchor="middle" fill="#33ff66">TEST</text>`);
  const buf = await svgToStaticGif(svg);
  assert.ok(buf.slice(0, 6).toString("ascii").startsWith("GIF"));
  assert.equal(buf.readUInt16LE(6), 240);
  assert.equal(buf.readUInt16LE(8), 135);
  assert.ok(buf.length > 500, `gif suspiciously small: ${buf.length} bytes`);
});

test("claude-usage view renders with the full data shape", async () => {
  const buf = await claudeUsage.render({
    tokensTotal: 2_400_000, cost: 4.20,
    lifetimeTokens: 47_200_000, lifetimeCost: 89.43,
    sessions: 3, intensity: 65,
    nowLabel: "14:23",
    fiveHourPct: 42, sevenDayPct: 68,
  });
  assert.ok(Buffer.isBuffer(buf));
  assert.ok(buf.slice(0, 6).toString("ascii").startsWith("GIF"));
});

test("claude-usage view tolerates null usage percentages", async () => {
  const buf = await claudeUsage.render({
    tokensTotal: 0, cost: 0, lifetimeTokens: 0, lifetimeCost: 0,
    sessions: 0, intensity: 0, nowLabel: "00:00",
    fiveHourPct: null, sevenDayPct: null,
  });
  assert.ok(Buffer.isBuffer(buf));
});

test("each slot 1 view renders a valid GIF", async () => {
  const state = {
    nowLabel: "12:00",
    byProject: [{ projectHash: "C--Users-Test-Projects-Demo", tokens_total: 1_234_567, cost: 0.42 }],
    sessionsToday: 2,
  };
  for (const view of [codingActivity, gitlabActive, gitlabRecentDefault, githubActive, githubRecentDefault, uptimerobot]) {
    const buf = await view.render(state);
    assert.ok(Buffer.isBuffer(buf), `${view.id} did not return a Buffer`);
    assert.ok(buf.slice(0, 6).toString("ascii").startsWith("GIF"), `${view.id} did not return a GIF`);
  }
});
