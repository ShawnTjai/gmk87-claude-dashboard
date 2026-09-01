/**
 * Fetches usage / rate-limit info from Anthropic's OAuth-authenticated
 * endpoint using the token stored by Claude Code in ~/.claude/.credentials.json.
 *
 * Endpoint: GET https://api.anthropic.com/api/oauth/usage
 *   Hard rate-limit: ~1 call per hour (responds 429 with retry-after ~3600s).
 *
 * Response shape (matches what claude.ai/settings/usage shows):
 *   {
 *     "five_hour": { "utilization": 0-100, "resets_at": "ISO8601" },
 *     "seven_day": { "utilization": 0-100, "resets_at": "ISO8601" },
 *     "seven_day_sonnet": {...} | null,
 *     "seven_day_opus":   {...} | null,
 *     "extra_usage": { "is_enabled": bool, ... }
 *   }
 *
 * IMPORTANT: this module reads OAuth credentials. Never log token values.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const CREDS_PATH = path.join(os.homedir(), ".claude", ".credentials.json");
const USAGE_URL  = "https://api.anthropic.com/api/oauth/usage";
// 1 hour cache TTL — matches the endpoint's documented ~1-call-per-hour
// rate limit. Earlier we cached for 60s and let the warmer call every 50s,
// which hit the limiter 72× the allowed rate and got us into an extended
// punishment cooldown (server-side retry-after grew to hours).
//
// The displayed 5h/7d bars only need rough hourly granularity anyway, so
// stale-for-up-to-an-hour data is fine. We accept this slightly stale view
// in exchange for staying inside the rate limit forever.
const CACHE_TTL_MS = 60 * 60_000;
const RATE_LIMIT_BACKOFF_MS = 60 * 60_000; // back off this long after a 429

let cached = null;       // last successful response body
let cachedAt = 0;        // ms timestamp
let lastError = null;    // last error (for diagnostics, not exposed publicly)

async function readToken() {
  const raw = await readFile(CREDS_PATH, "utf8");
  const creds = JSON.parse(raw);
  const token = creds?.claudeAiOauth?.accessToken;
  if (!token) {
    throw new Error("no claudeAiOauth.accessToken in ~/.claude/.credentials.json");
  }
  return token;
}

/**
 * Fetch usage from Anthropic. Returns cached data if within TTL.
 * Returns null (not throws) if the call fails AND there's no cache,
 * so the daemon can keep running with partial data.
 */
export async function fetchUsage({ force = false } = {}) {
  const now = Date.now();
  if (!force && cached && now - cachedAt < CACHE_TTL_MS) return cached;
  // Respect rate-limit backoff even when force=true. A prior 429 pushes
  // `cachedAt` forward to "earliest safe retry time"; if we issue another
  // request before that, Anthropic just returns another 429 with a fresh
  // retry-after — effectively rolling our own ban window. The warmer
  // (every 50 s) was triggering exactly this loop.
  if (cachedAt > now) return cached;

  try {
    const token = await readToken();
    // Headers exactly match slopware/claude-quota — verified working. The
    // anthropic-beta header is the one we were missing initially.
    const res = await fetch(USAGE_URL, {
      headers: {
        authorization: `Bearer ${token}`,
        "anthropic-beta": "oauth-2025-04-20",
        "content-type": "application/json",
        "user-agent": "claude-code/1.0",
      },
    });

    if (res.status === 429) {
      // Push cachedAt forward so we don't hammer the endpoint while
      // rate-limited (slopware/claude-quota's "back off" pattern).
      const retry = parseInt(res.headers.get("retry-after") || "300", 10);
      cachedAt = now + Math.max(retry * 1000, RATE_LIMIT_BACKOFF_MS) - CACHE_TTL_MS;
      lastError = `rate-limited, backing off ${retry}s`;
      console.warn(`[usage-api] ${lastError} — using ${cached ? "cached" : "no"} data`);
      return cached;
    }

    if (!res.ok) {
      lastError = `HTTP ${res.status}`;
      console.warn(`[usage-api] ${lastError} — using ${cached ? "cached" : "no"} data`);
      return cached;
    }

    cached = await res.json();
    cachedAt = now;
    lastError = null;
    return cached;
  } catch (err) {
    lastError = err.message;
    console.warn(`[usage-api] fetch failed: ${err.message} — using ${cached ? "cached" : "no"} data`);
    return cached;
  }
}

export function getLastError() {
  return lastError;
}

/** Pure-function helper exported for tests. */
export function extractBars(usage) {
  if (!usage) return { fiveHourPct: null, sevenDayPct: null, fiveHourResetsAt: null, sevenDayResetsAt: null };
  return {
    fiveHourPct: usage.five_hour?.utilization ?? null,
    sevenDayPct: usage.seven_day?.utilization ?? null,
    fiveHourResetsAt: usage.five_hour?.resets_at ?? null,
    sevenDayResetsAt: usage.seven_day?.resets_at ?? null,
  };
}
