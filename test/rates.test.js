import { test } from "node:test";
import assert from "node:assert/strict";
import { getRate, costForMessage } from "../src/rates.js";

test("getRate returns Sonnet rates for unknown model and warns", () => {
  const rate = getRate("claude-unknown-model");
  assert.equal(rate.input, 3.0);
  assert.equal(rate.output, 15.0);
});

test("getRate maps current Opus (4.5+/5) to $5/$25 API rates", () => {
  for (const id of ["claude-opus-4-5-20251101", "claude-opus-4-6", "claude-opus-4-8", "claude-opus-5"]) {
    const rate = getRate(id);
    assert.equal(rate.input, 5.0, id);
    assert.equal(rate.output, 25.0, id);
    assert.equal(rate.cache_5m, 6.25, id);
    assert.equal(rate.cache_1h, 10.0, id);
    assert.equal(rate.cache_read, 0.50, id); // 10% of input, true API rate
  }
});

test("getRate maps legacy Opus (3/4.0/4.1) to $15/$75 API rates", () => {
  // Opus 4.0 has no minor version — a date sits right after "opus-4-".
  for (const id of ["claude-3-opus-20240229", "claude-opus-4-20250514", "claude-opus-4-1-20250805"]) {
    const rate = getRate(id);
    assert.equal(rate.input, 15.0, id);
    assert.equal(rate.output, 75.0, id);
    assert.equal(rate.cache_5m, 18.75, id);
    assert.equal(rate.cache_1h, 30.0, id);
    assert.equal(rate.cache_read, 1.50, id);
  }
});

test("getRate maps Fable/Mythos to $10/$50 (not the Sonnet fallback)", () => {
  for (const id of ["claude-fable-5", "claude-mythos-5"]) {
    const rate = getRate(id);
    assert.equal(rate.input, 10.0, id);
    assert.equal(rate.output, 50.0, id);
    assert.equal(rate.cache_read, 1.00, id);
  }
});

test("costForMessage prices a heavy-cache Opus 5 session at true API rates", () => {
  // 213.6k input + 11.2m output + 9.3b cache_read + 92.7m cache_write (5m).
  // input     213_600      @ $5/M   = $1.068
  // output    11_200_000   @ $25/M  = $280
  // cache_rd  9_300_000_000 @ $0.50/M = $4650
  // cache_5m  92_700_000   @ $6.25/M = $579.375
  const cost = costForMessage("claude-opus-5", {
    input_tokens: 213_600,
    output_tokens: 11_200_000,
    cache_read_input_tokens: 9_300_000_000,
    cache_creation_input_tokens: 92_700_000,
  });
  assert.equal(Number(cost.toFixed(3)), 5510.443);
});

test("costForMessage includes web_search billing", () => {
  // 5 searches at $0.01 each = $0.05
  const cost = costForMessage("claude-haiku-4-5", {
    input_tokens: 0,
    output_tokens: 0,
    server_tool_use: { web_search_requests: 5 },
  });
  assert.equal(cost, 0.05);
});

test("getRate matches Sonnet 4 family by prefix", () => {
  const rate = getRate("claude-sonnet-4-6");
  assert.equal(rate.input, 3.0);
  assert.equal(rate.output, 15.0);
});

test("getRate matches Haiku 4 family by prefix", () => {
  const rate = getRate("claude-haiku-4-5-20251001");
  assert.equal(rate.input, 1.0);
  assert.equal(rate.output, 5.0);
});

test("costForMessage sums all token kinds correctly", () => {
  // Sonnet rates: input=3, cache_creation=3.75, cache_read=0.30, output=15 (per 1M tokens)
  // 1M input + 1M cache_creation + 1M cache_read + 1M output
  // = 3 + 3.75 + 0.30 + 15 = 22.05 USD
  const cost = costForMessage("claude-sonnet-4-6", {
    input_tokens: 1_000_000,
    cache_creation_input_tokens: 1_000_000,
    cache_read_input_tokens: 1_000_000,
    output_tokens: 1_000_000,
  });
  assert.equal(Number(cost.toFixed(4)), 22.05);
});

test("costForMessage handles missing token fields as zero", () => {
  const cost = costForMessage("claude-opus-5", { input_tokens: 1_000_000 });
  // 1M input @ $5/M = $5 (current Opus tier)
  assert.equal(cost, 5.0);
});

test("costForMessage prices legacy Opus input at $15/M", () => {
  const cost = costForMessage("claude-opus-4-1-20250805", { input_tokens: 1_000_000 });
  assert.equal(cost, 15.0);
});

test("costForMessage uses 1h cache rate when ephemeral_1h_input_tokens present", () => {
  // Sonnet 1h cache rate is $6/M (2x input)
  const cost = costForMessage("claude-sonnet-4-6", {
    cache_creation_input_tokens: 1_000_000,
    cache_creation: { ephemeral_1h_input_tokens: 1_000_000, ephemeral_5m_input_tokens: 0 },
  });
  assert.equal(cost, 6.0);
});

test("costForMessage uses 5m cache rate when ephemeral_5m_input_tokens present", () => {
  // Sonnet 5m cache rate is $3.75/M (1.25x input)
  const cost = costForMessage("claude-sonnet-4-6", {
    cache_creation_input_tokens: 1_000_000,
    cache_creation: { ephemeral_5m_input_tokens: 1_000_000, ephemeral_1h_input_tokens: 0 },
  });
  assert.equal(cost, 3.75);
});

test("costForMessage mixes 5m + 1h cache correctly when both present", () => {
  // Sonnet: 500k 5m ($3.75/M * 0.5 = $1.875) + 500k 1h ($6/M * 0.5 = $3) = $4.875
  const cost = costForMessage("claude-sonnet-4-6", {
    cache_creation_input_tokens: 1_000_000,
    cache_creation: { ephemeral_5m_input_tokens: 500_000, ephemeral_1h_input_tokens: 500_000 },
  });
  assert.equal(Number(cost.toFixed(4)), 4.875);
});
