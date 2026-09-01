// Per-model API list rates (USD per 1M tokens), pegged to Anthropic's published
// pay-as-you-go pricing. The on-screen cost is "what these tokens would cost on
// the API today" — NOT Claude Code's `/cost` subscription view. (v1.0.0 bent the
// Opus cache_read rate to mirror `/cost`; that calibration was dropped 2026-08-20
// in favour of true list rates.)
//
// Cache write tiers are derived, not observed: 5-minute ephemeral writes bill at
// 1.25× input, 1-hour writes at 2× input. cache_read bills at 10% of input.
//   - web_search: $0.01 per request (server_tool_use.web_search_requests)
//
// Pricing sources (per MTok input / output):
//   Fable 5, Mythos 5           $10 / $50
//   Opus 5 / 4.8 / 4.7 / 4.6 / 4.5   $5 / $25   (current Opus tier)
//   Opus 4.1 / 4.0 / 3          $15 / $75   (legacy Opus tier — historical sessions)
//   Sonnet 5 / 4.6 (and older)   $3 / $15   (Sonnet 5 intro $2/$10 through 2026-08-31 not applied)
//   Haiku 4.5                    $1 / $5
const RATES = {
  // Opus 4.5+ and Opus 5 — current Opus pricing.
  opus:        { input:  5.0, cache_5m:  6.25, cache_1h: 10.0, cache_read: 0.50, output: 25.0 },
  // Opus 3 / 4.0 / 4.1 — legacy Opus pricing, still correct for old transcripts.
  opus_legacy: { input: 15.0, cache_5m: 18.75, cache_1h: 30.0, cache_read: 1.50, output: 75.0 },
  // Fable 5 / Mythos 5.
  fable:       { input: 10.0, cache_5m: 12.50, cache_1h: 20.0, cache_read: 1.00, output: 50.0 },
  // Sonnet (5 / 4.6 / 4.5 / …).
  sonnet:      { input:  3.0, cache_5m:  3.75, cache_1h:  6.0, cache_read: 0.30, output: 15.0 },
  // Haiku (4.5 / …).
  haiku:       { input:  1.0, cache_5m:  1.25, cache_1h:  2.0, cache_read: 0.10, output:  5.0 },
};

const WEB_SEARCH_USD = 0.01;

const warnedModels = new Set();

// Claude Code writes "<synthetic>" rows for internal placeholders (zero-usage
// markers around tool results, summaries, retries). Counted in messages but
// they contribute nothing to cost — skip the warning for them.
const KNOWN_NON_BILLED = new Set(["<synthetic>"]);

// Opus dropped from $15/$75 to $5/$25 starting with Opus 4.5 (2025-11). Opus 3,
// Opus 4.0, and Opus 4.1 remain on the legacy tier. Model-ID shapes:
//   legacy:  claude-3-opus-…  ·  claude-opus-4-1-…  ·  claude-opus-4-<YYYYMMDD>  (4.0)
//   current: claude-opus-4-5-…  4-6  4-7  4-8  ·  claude-opus-5
// Note Opus 4.0 has no minor version — a 6+ digit date sits right after "opus-4-",
// which is what distinguishes it from 4.5+.
function isLegacyOpus(modelId) {
  if (modelId.includes("claude-3-opus")) return true;   // Opus 3
  if (/opus-4-1\b/.test(modelId)) return true;          // Opus 4.1
  if (/opus-4-\d{6,}/.test(modelId)) return true;       // Opus 4.0 (date suffix)
  return false;                                         // Opus 4.5+/5 → current tier
}

export function getRate(modelId) {
  if (typeof modelId !== "string") return RATES.sonnet;
  if (modelId.includes("opus"))   return isLegacyOpus(modelId) ? RATES.opus_legacy : RATES.opus;
  if (modelId.includes("fable") || modelId.includes("mythos")) return RATES.fable;
  if (modelId.includes("sonnet")) return RATES.sonnet;
  if (modelId.includes("haiku"))  return RATES.haiku;
  if (!KNOWN_NON_BILLED.has(modelId) && !warnedModels.has(modelId)) {
    console.warn(`[rates] unknown model "${modelId}" — falling back to Sonnet rates`);
    warnedModels.add(modelId);
  }
  return RATES.sonnet;
}

export function costForMessage(modelId, usage) {
  const r = getRate(modelId);
  const u = usage || {};

  // Split cache_creation_input_tokens into 5-min vs 1-hour tiers if the
  // detailed breakdown is present. The transcript shape is:
  //   usage.cache_creation_input_tokens: <total>
  //   usage.cache_creation: { ephemeral_5m_input_tokens, ephemeral_1h_input_tokens }
  // If the breakdown is absent, assume all 5-min (the cheaper default).
  const ccTotal = u.cache_creation_input_tokens || 0;
  const cc = u.cache_creation || {};
  const cc5m = cc.ephemeral_5m_input_tokens || 0;
  const cc1h = cc.ephemeral_1h_input_tokens || 0;
  let billed5m = cc5m;
  let billed1h = cc1h;
  if (cc5m === 0 && cc1h === 0 && ccTotal > 0) {
    billed5m = ccTotal;
  } else {
    const accounted = cc5m + cc1h;
    if (ccTotal > accounted) billed5m += (ccTotal - accounted);
  }

  const inp = (u.input_tokens           || 0) * r.input      / 1_000_000;
  const c5m = billed5m                          * r.cache_5m   / 1_000_000;
  const c1h = billed1h                          * r.cache_1h   / 1_000_000;
  const cr  = (u.cache_read_input_tokens || 0) * r.cache_read / 1_000_000;
  const out = (u.output_tokens           || 0) * r.output     / 1_000_000;
  const websearch = (u.server_tool_use?.web_search_requests || 0) * WEB_SEARCH_USD;
  return inp + c5m + c1h + cr + out + websearch;
}
