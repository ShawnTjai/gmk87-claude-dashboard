/**
 * Slot 0 is pinned to a single view (Claude Code Usage) — predictable place
 * to land when you want the headline metric.
 *
 * Slot 1 cycles through the whole SLIDESHOW_VIEWS list (Claude Usage included)
 * every SLIDESHOW_INTERVAL_MS, so you get the slideshow experience there.
 *
 * Fn+Enter on the keyboard cycles: clock → slot 0 (CC) → slot 1 (rotating) → clock
 */
import claudeUsage from "./claude-usage.js";
import azureCost from "./azure-cost.js";
import { makeCloudflarePage } from "./cloudflare-overview.js";
import gitlabActive from "./gitlab-active.js";
import { makeGitlabRecentPage } from "./gitlab-recent.js";
import githubActive from "./github-active.js";
import { makeGithubRecentPage } from "./github-recent.js";
import codingActivity from "./coding-activity.js";
import uptimerobot from "./uptimerobot.js";

export const PINNED_VIEW = claudeUsage;

// Cloudflare pages: hardcoded count for now. With 6 zones per page and 28
// configured zones, 5 pages covers everything (last page has 4 zones).
// If you add zones beyond 30, bump this number (each extra page = 6 more
// zones visible). Future: derive dynamically at daemon boot from a single
// fetchOverview() call.
const CLOUDFLARE_PAGES = 5;
const cloudflareSlides = Array.from({ length: CLOUDFLARE_PAGES }, (_, i) => makeCloudflarePage(i));

// GitLab recent pipelines: 6 rows/page. With maxProjects=30 in gitlab.config,
// 5 pages cover everything. Bump if you raise maxProjects.
const GITLAB_RECENT_PAGES = 5;
const gitlabRecentSlides = Array.from({ length: GITLAB_RECENT_PAGES }, (_, i) => makeGitlabRecentPage(i));

// GitHub recent workflow runs: 6 rows/page. Same math as GitLab.
const GITHUB_RECENT_PAGES = 5;
const githubRecentSlides = Array.from({ length: GITHUB_RECENT_PAGES }, (_, i) => makeGithubRecentPage(i));

// Order matters: first entry is what slot 1 shows right after daemon
// boot, so the user can visually confirm they're on slot 1 (not the
// pinned slot 0 = Claude Code Usage).
export const SLIDESHOW_VIEWS = [
  uptimerobot,              // shows ALL ONLINE in rotation; priority-pins on outage
  azureCost,                // boot here — visually distinct from slot 0
  ...cloudflareSlides,      // 5 consecutive slides walking through all zones
  gitlabActive,             // currently-running pipelines (auto-hides when idle)
  ...gitlabRecentSlides,    // paginated recent pipelines (6 rows/page)
  githubActive,             // currently-running workflows (auto-hides when idle)
  ...githubRecentSlides,    // paginated recent workflows (6 rows/page)
  codingActivity,           // today's coding activity — top projects by tokens
  claudeUsage,              // last — also serves as a "slot 0 mirror" before cycle restart
];

export const SLIDESHOW_INTERVAL_MS = 5_000;
