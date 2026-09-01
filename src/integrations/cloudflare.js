/**
 * Cloudflare integration.
 *
 * Per token+account: list zones, then batch GraphQL query for httpRequests1dGroups
 * (1-day granularity — required for Free plan zones; Pro+ could use 1m/1h but we
 * keep it uniform across plans). Skips zones whose plan doesn't expose analytics.
 *
 * Public API:
 *   fetchOverview() → {
 *     totalRequests, total5xx, errorRate,           // aggregated across all accounts
 *     topZones: [{ name, requests, errors5xx, errorRate }],   // sorted desc by requests
 *     fetchedAt, staleness,
 *   }
 */

import { readFile } from "node:fs/promises";
import path from "node:path";

const CONFIG_PATH = path.resolve("cloudflare.config.json");
const CACHE_TTL_MS = 5 * 60_000; // 5 min — daily granularity changes slowly anyway
const ZONES_PER_BATCH = 10;       // Cloudflare GraphQL limit per query

let cached = null;
let cachedAt = 0;

async function loadConfig() {
  return JSON.parse(await readFile(CONFIG_PATH, "utf8"));
}

async function listZones(token, accountId) {
  const r = await fetch(`https://api.cloudflare.com/client/v4/zones?account.id=${accountId}&per_page=50`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const j = await r.json();
  if (!j.success) throw new Error(`zone list failed: ${j.errors?.[0]?.message || r.status}`);
  return (j.result || []).map((z) => ({ id: z.id, name: z.name, plan: z.plan?.name }));
}

const GQL = `
  query Z($zones: [string!]!, $since: Date!) {
    viewer {
      zones(filter: { zoneTag_in: $zones }) {
        zoneTag
        httpRequests1dGroups(limit: 100, filter: { date_geq: $since }) {
          sum { requests responseStatusMap { edgeResponseStatus requests } }
        }
      }
    }
  }
`;

function aggregateZone(zoneNode) {
  let requests = 0, errors5xx = 0;
  for (const g of zoneNode.httpRequests1dGroups || []) {
    requests += g.sum?.requests || 0;
    for (const s of g.sum?.responseStatusMap || []) {
      if (s.edgeResponseStatus >= 500 && s.edgeResponseStatus < 600) errors5xx += s.requests || 0;
    }
  }
  return { requests, errors5xx };
}

async function queryBatch(token, zoneIds, since) {
  const r = await fetch("https://api.cloudflare.com/client/v4/graphql", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query: GQL, variables: { zones: zoneIds, since } }),
  });
  return await r.json();
}

export async function fetchOverview({ force = false } = {}) {
  const now = Date.now();
  if (!force && cached && now - cachedAt < CACHE_TTL_MS) return { ...cached, staleness: "cached" };

  let cfg;
  try {
    cfg = await loadConfig();
  } catch (err) {
    console.warn(`[cloudflare] config load failed: ${err.message}`);
    return cached ? { ...cached, staleness: "cached" }
                  : { totalRequests: 0, total5xx: 0, errorRate: 0, topZones: [], fetchedAt: new Date(), staleness: "failed" };
  }

  const since = new Date().toISOString().slice(0, 10); // YYYY-MM-DD UTC
  const allZones = []; // { name, requests, errors5xx }

  for (const tokenEntry of cfg.tokens) {
    if (!tokenEntry.apiToken || tokenEntry.apiToken.startsWith("REPLACE_")) continue;
    for (const accountId of tokenEntry.accountIds) {
      let zones;
      try {
        zones = await listZones(tokenEntry.apiToken, accountId);
      } catch (err) {
        console.warn(`[cloudflare] zones list failed for ${accountId.slice(0, 8)}: ${err.message}`);
        continue;
      }

      // Batch in chunks of ZONES_PER_BATCH
      for (let i = 0; i < zones.length; i += ZONES_PER_BATCH) {
        const batch = zones.slice(i, i + ZONES_PER_BATCH);
        const resp = await queryBatch(tokenEntry.apiToken, batch.map((z) => z.id), since);
        if (resp.errors) {
          // Fall back to one-by-one to isolate the offender(s)
          for (const z of batch) {
            const single = await queryBatch(tokenEntry.apiToken, [z.id], since);
            if (single.errors) continue; // skip silently — typically a plan limit
            for (const dz of single.data?.viewer?.zones || []) {
              const stats = aggregateZone(dz);
              allZones.push({ name: z.name, ...stats });
            }
          }
        } else {
          for (const dz of resp.data?.viewer?.zones || []) {
            const stats = aggregateZone(dz);
            const name = batch.find((z) => z.id === dz.zoneTag)?.name || dz.zoneTag;
            allZones.push({ name, ...stats });
          }
        }
      }
    }
  }

  const totalRequests = allZones.reduce((s, z) => s + z.requests, 0);
  const total5xx = allZones.reduce((s, z) => s + z.errors5xx, 0);
  const errorRate = totalRequests ? (total5xx / totalRequests) * 100 : 0;
  // Sorted descending by traffic so paginated slides put busiest zones first.
  const sortedZones = allZones
    .sort((a, b) => b.requests - a.requests)
    .map((z) => ({
      ...z,
      errorRate: z.requests ? (z.errors5xx / z.requests) * 100 : 0,
    }));

  cached = {
    totalRequests,
    total5xx,
    errorRate,
    zones: sortedZones,    // ALL zones (paginated by the view)
    fetchedAt: new Date(),
  };
  cachedAt = now;
  return { ...cached, staleness: "fresh" };
}
