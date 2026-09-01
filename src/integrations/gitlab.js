/**
 * GitLab pipeline integration — one GraphQL call returns the latest pipeline
 * for each project the token has access to (sorted by latest activity).
 *
 * From that single response we derive both slideshow views:
 *   - "active" = pipelines currently in flight (running/pending/etc.)
 *   - "recent" = last N pipelines by updatedAt, any status
 *
 * Public API:
 *   fetchPipelineActivity({ force? }) → {
 *     active: [{ project, ref, status, updatedAt, ageSeconds }],
 *     recent: [{ project, ref, status, updatedAt, ageSeconds }],
 *     fetchedAt, staleness, error?,
 *   }
 */

import { readFile } from "node:fs/promises";
import path from "node:path";

const CONFIG_PATH = path.resolve("gitlab.config.json");
const CACHE_TTL_MS = 60_000; // 1 min — pipelines change fast, want near-live

const ACTIVE_STATUSES = new Set([
  "RUNNING", "PENDING", "CREATED", "WAITING_FOR_RESOURCE", "PREPARING", "SCHEDULED",
]);

let cached = null;
let cachedAt = 0;

async function loadConfig() {
  return JSON.parse(await readFile(CONFIG_PATH, "utf8"));
}

const GQL = `
  query LatestPipelines($membership: Boolean, $first: Int!) {
    projects(membership: $membership, first: $first, sort: "latest_activity_desc") {
      nodes {
        nameWithNamespace
        path
        pipelines(first: 1) {
          nodes {
            status
            ref
            updatedAt
            createdAt
            duration
          }
        }
      }
    }
  }
`;

async function graphql(cfg) {
  const r = await fetch(`${cfg.host.replace(/\/$/, "")}/api/graphql`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${cfg.token}`,
    },
    body: JSON.stringify({
      query: GQL,
      variables: {
        membership: (cfg.projectScope || "membership") === "membership",
        first: cfg.maxProjects || 30,
      },
    }),
  });
  const text = await r.text();
  let body;
  try { body = JSON.parse(text); } catch { throw new Error(`gitlab non-JSON ${r.status}: ${text.slice(0, 200)}`); }
  if (!r.ok) throw new Error(`gitlab HTTP ${r.status}: ${text.slice(0, 200)}`);
  if (body.errors) throw new Error(`gitlab gql: ${body.errors[0]?.message}`);
  return body.data;
}

function ageSeconds(iso) {
  return Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
}

export async function fetchPipelineActivity({ force = false } = {}) {
  if (!force && cached && Date.now() - cachedAt < CACHE_TTL_MS) {
    return { ...cached, staleness: "cached" };
  }

  try {
    const cfg = await loadConfig();
    const data = await graphql(cfg);

    const rows = [];
    for (const p of data.projects?.nodes || []) {
      const pipe = p.pipelines?.nodes?.[0];
      if (!pipe) continue;
      rows.push({
        project: p.nameWithNamespace || p.path,
        ref: pipe.ref || "—",
        status: pipe.status, // SUCCESS / FAILED / RUNNING / CANCELED / PENDING / SKIPPED / etc.
        updatedAt: pipe.updatedAt,
        ageSeconds: ageSeconds(pipe.updatedAt),
      });
    }
    rows.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));

    const active = rows.filter((r) => ACTIVE_STATUSES.has(r.status));
    const recent = rows;

    cached = { active, recent, fetchedAt: Date.now(), staleness: "fresh" };
    cachedAt = Date.now();
    return cached;
  } catch (err) {
    if (cached) {
      return { ...cached, staleness: "error-cached", error: err.message };
    }
    return { active: [], recent: [], fetchedAt: Date.now(), staleness: "error", error: err.message };
  }
}
