/**
 * GitHub Actions integration — lists your most-recently-pushed repos, then
 * fetches the latest workflow run per repo. Combines them into the same
 * shape as the GitLab integration so the views can be near-identical.
 *
 * N+1 REST calls (one repo list + one runs-per-repo). With maxRepos=30
 * that's 31 calls per cache cycle — comfortably under 5000/hr auth limit.
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

const CONFIG_PATH = path.resolve("github.config.json");
const CACHE_TTL_MS = 60_000;

// Normalize GitHub's two-field state (status + conclusion) to the same
// uppercase tokens we use for GitLab so the views can share styling.
const ACTIVE_STATUSES = new Set(["RUNNING", "PENDING", "QUEUED", "WAITING", "REQUESTED"]);

let cached = null;
let cachedAt = 0;

async function loadConfig() {
  return JSON.parse(await readFile(CONFIG_PATH, "utf8"));
}

function authHeaders(token) {
  return {
    authorization: `Bearer ${token}`,
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    "user-agent": "gmk87-stats-daemon",
  };
}

function normalizeStatus(run) {
  // GitHub run status: queued | in_progress | completed | waiting | requested | pending
  // When completed, conclusion: success | failure | cancelled | skipped | neutral | timed_out | action_required | stale | startup_failure
  if (run.status !== "completed") {
    if (run.status === "in_progress") return "RUNNING";
    if (run.status === "queued") return "QUEUED";
    if (run.status === "waiting") return "WAITING";
    if (run.status === "requested") return "REQUESTED";
    if (run.status === "pending") return "PENDING";
    return run.status.toUpperCase();
  }
  switch (run.conclusion) {
    case "success":      return "SUCCESS";
    case "failure":      return "FAILED";
    case "cancelled":    return "CANCELED";
    case "skipped":      return "SKIPPED";
    case "timed_out":    return "FAILED";
    case "action_required": return "MANUAL";
    case "neutral":      return "SKIPPED";
    case "stale":        return "SKIPPED";
    case "startup_failure": return "FAILED";
    default:             return (run.conclusion || "UNKNOWN").toUpperCase();
  }
}

function ageSeconds(iso) {
  return Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
}

async function listRepos(cfg) {
  const params = new URLSearchParams({
    per_page: String(Math.min(100, cfg.maxRepos || 30)),
    sort: "pushed",
    direction: "desc",
    affiliation: cfg.affiliation || "owner,collaborator,organization_member",
  });
  const r = await fetch(`https://api.github.com/user/repos?${params}`, { headers: authHeaders(cfg.token) });
  if (!r.ok) throw new Error(`/user/repos HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const repos = await r.json();
  return repos.slice(0, cfg.maxRepos || 30);
}

async function latestRun(cfg, fullName) {
  const r = await fetch(`https://api.github.com/repos/${fullName}/actions/runs?per_page=1`, { headers: authHeaders(cfg.token) });
  if (!r.ok) return null; // repo may have Actions disabled — skip silently
  const body = await r.json();
  return body.workflow_runs?.[0] || null;
}

export async function fetchPipelineActivity({ force = false } = {}) {
  if (!force && cached && Date.now() - cachedAt < CACHE_TTL_MS) {
    return { ...cached, staleness: "cached" };
  }

  try {
    const cfg = await loadConfig();
    const repos = await listRepos(cfg);

    // Parallelize the N+1 in batches — sequential was taking 5-15s when the
    // cache was cold, which the slideshow noticed as a stuck slide. 8-wide
    // keeps GitHub's secondary rate limits happy on typical accounts.
    const CONCURRENCY = 8;
    const runs = new Array(repos.length).fill(null);
    for (let i = 0; i < repos.length; i += CONCURRENCY) {
      const batch = repos.slice(i, i + CONCURRENCY);
      const batchRuns = await Promise.all(
        batch.map((repo) => latestRun(cfg, repo.full_name).catch(() => null))
      );
      batchRuns.forEach((run, j) => { runs[i + j] = run; });
    }

    const rows = [];
    repos.forEach((repo, idx) => {
      const run = runs[idx];
      if (!run) return;
      const status = normalizeStatus(run);
      rows.push({
        project: repo.full_name,
        ref: run.head_branch || repo.default_branch || "—",
        status,
        updatedAt: run.updated_at,
        ageSeconds: ageSeconds(run.updated_at),
      });
    });
    rows.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));

    const active = rows.filter((r) => ACTIVE_STATUSES.has(r.status));
    const recent = rows;

    cached = { active, recent, fetchedAt: Date.now(), staleness: "fresh" };
    cachedAt = Date.now();
    return cached;
  } catch (err) {
    if (cached) return { ...cached, staleness: "error-cached", error: err.message };
    return { active: [], recent: [], fetchedAt: Date.now(), staleness: "error", error: err.message };
  }
}
