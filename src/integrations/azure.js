/**
 * Azure cost integration.
 *
 * Uses the Microsoft.Consumption UsageDetails API (not Cost Management Query,
 * which is too aggressively throttled). For each Service Principal account
 * configured in azure.config.json, gets a Bearer token via client_credentials,
 * then queries each subscription's MTD line items and sums them.
 *
 * Public API:
 *   fetchUsage()  →  {
 *     total: number,                       // sum across all subs (currencies mixed; see byCurrency)
 *     byCurrency: { USD: 12.34, SGD: 56.78 },
 *     bySubscription: [
 *       { accountLabel, subId, name, cost, currency, error?: string },
 *       ...
 *     ],
 *     fetchedAt: Date,
 *     staleness: 'fresh' | 'cached' | 'failed',
 *   }
 */

import { readFile } from "node:fs/promises";
import path from "node:path";

const CONFIG_PATH = path.resolve("azure.config.json");

// Cache: Azure cost data has 8-24h lag server-side, polling more than ~30 min
// is wasted. Tokens valid 1h — refresh ~5 min before expiry.
const COST_CACHE_TTL_MS = 30 * 60_000;

let cached = null;
let cachedAt = 0;
// Keyed by clientId (SP appId), NOT tenantId — two SPs in the same tenant
// must get distinct tokens or one will accidentally use the other's identity
// and hit AuthorizationFailed on the wrong SP's role assignments.
const tokenCache = new Map(); // clientId -> { token, expiresAt }

async function loadConfig() {
  const txt = await readFile(CONFIG_PATH, "utf8");
  const cfg = JSON.parse(txt);
  // Skip un-filled template entries
  cfg.accounts = (cfg.accounts || []).filter((a) => !a.tenantId?.startsWith("0000"));
  return cfg;
}

async function getToken(account) {
  const cachedEntry = tokenCache.get(account.clientId);
  if (cachedEntry && Date.now() < cachedEntry.expiresAt - 5 * 60_000) {
    return cachedEntry.token;
  }
  const res = await fetch(`https://login.microsoftonline.com/${account.tenantId}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: account.clientId,
      client_secret: account.clientSecret,
      scope: "https://management.azure.com/.default",
    }),
  });
  if (!res.ok) {
    throw new Error(`token failed for ${account.label}: ${res.status}`);
  }
  const j = await res.json();
  tokenCache.set(account.clientId, {
    token: j.access_token,
    expiresAt: Date.now() + j.expires_in * 1000,
  });
  return j.access_token;
}

async function querySubscription({ token, subId }) {
  const now = new Date();
  const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
  let url = `https://management.azure.com/subscriptions/${subId}/providers/Microsoft.Consumption/usageDetails`
    + `?$filter=properties/usageStart ge '${monthStart}'`
    + `&$top=1000`
    + `&api-version=2024-08-01`;

  let total = 0;
  let currency = "—";
  let pages = 0;

  while (url) {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    });
    if (!res.ok) {
      throw new Error(`${res.status} ${(await res.text()).slice(0, 120)}`);
    }
    const data = await res.json();
    for (const item of data.value || []) {
      const p = item.properties || {};
      total += Number(p.cost ?? p.costInBillingCurrency ?? 0);
      currency = p.billingCurrency || p.billingCurrencyCode || currency;
    }
    pages++;
    url = data.nextLink || null;
    // Safety bound: don't paginate forever on a runaway sub
    if (pages > 50) break;
  }

  return { total, currency };
}

export async function fetchUsage({ force = false } = {}) {
  const now = Date.now();
  if (!force && cached && now - cachedAt < COST_CACHE_TTL_MS) {
    return { ...cached, staleness: "cached" };
  }

  let cfg;
  try {
    cfg = await loadConfig();
  } catch (err) {
    console.warn(`[azure] config load failed: ${err.message}`);
    if (cached) return { ...cached, staleness: "cached" };
    return { total: 0, byCurrency: {}, bySubscription: [], fetchedAt: new Date(), staleness: "failed" };
  }

  const bySubscription = [];
  let total = 0;
  const byCurrency = {};

  for (const account of cfg.accounts) {
    let token;
    try {
      token = await getToken(account);
    } catch (err) {
      // Auth failure — mark every sub in this account as errored
      for (const sub of account.subscriptions) {
        bySubscription.push({
          accountLabel: account.label, subId: sub.id, name: sub.name,
          cost: 0, currency: "—", error: err.message,
        });
      }
      continue;
    }
    for (const sub of account.subscriptions) {
      try {
        const { total: cost, currency } = await querySubscription({ token, subId: sub.id });
        bySubscription.push({
          accountLabel: account.label, subId: sub.id, name: sub.name,
          cost, currency,
        });
        total += cost;
        byCurrency[currency] = (byCurrency[currency] || 0) + cost;
      } catch (err) {
        bySubscription.push({
          accountLabel: account.label, subId: sub.id, name: sub.name,
          cost: 0, currency: "—", error: err.message,
        });
      }
    }
  }

  cached = {
    total,
    byCurrency,
    bySubscription,
    fetchedAt: new Date(),
  };
  cachedAt = now;
  return { ...cached, staleness: "fresh" };
}
