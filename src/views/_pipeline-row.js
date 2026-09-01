/**
 * Shared row primitives + status mapping for the four pipeline views
 * (gitlab-active, gitlab-recent, github-active, github-recent).
 *
 * Integrations normalize their respective APIs into the same status tokens
 * (SUCCESS / FAILED / RUNNING / ...), so a single color + glyph map works
 * across both providers.
 */
import { GREEN, COLOR_IDLE, COLOR_LOW, COLOR_MED, COLOR_HOT } from "./_shared.js";

// Known-long org/group/owner names get short aliases to free up column width.
// Applied as substring replacement (not just whole-segment) so repo names
// like "AcmeCorp-Website" also benefit: "AcmeCorp-Website" -> "AC-Website".
//
// These are examples. Replace them with your own org/group/owner names; keys
// are matched as case-sensitive substrings against the project path.
export const ABBREVIATIONS = {
  "AcmeCorp":   "AC",
  "WidgetsInc": "WI",
  "CloudFlare": "CF",
  "Cloudflare": "CF",
  "ShawnTjai":  "ST",
};

const ACTIVE_STATUSES = new Set([
  "RUNNING", "PENDING", "CREATED", "QUEUED", "WAITING",
  "WAITING_FOR_RESOURCE", "PREPARING", "SCHEDULED", "REQUESTED",
]);

export function applyAbbreviations(s) {
  if (!s) return s;
  let out = s;
  for (const [from, to] of Object.entries(ABBREVIATIONS)) {
    if (out.includes(from)) out = out.split(from).join(to);
  }
  return out;
}

export function escapeXml(s) {
  return String(s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

export function truncate(s, max) {
  if (!s) return "";
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}

export function ageLabel(seconds) {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

/**
 * Show the leaf (repo) name. If the column has leftover room after the
 * leaf, fill it with a truncated immediate-parent prefix so short names
 * ("Back") get context ("RoC/Back" after abbreviation).
 *
 * Abbreviations are applied as substring replacement before the path is
 * split, so they affect both group prefixes and repo names containing
 * those tokens.
 */
export function shortProject(full, max = 16) {
  if (!full) return "";
  const abbreviated = applyAbbreviations(full);
  const parts = abbreviated.split("/").map((s) => s.trim()).filter(Boolean);
  if (parts.length === 0) return "";
  const leaf = parts[parts.length - 1];
  if (parts.length === 1) return truncate(leaf, max);
  const joined = parts.join("/");
  if (joined.length <= max) return joined;
  if (leaf.length >= max) return truncate(leaf, max);
  const parent = parts[parts.length - 2];
  const remaining = max - leaf.length - 1; // 1 char for "/"
  if (remaining < 3) return leaf;            // not enough for "X…" — drop prefix
  const trimmedParent = parent.length <= remaining ? parent : parent.slice(0, remaining - 1) + "…";
  return `${trimmedParent}/${leaf}`;
}

export function statusColor(status) {
  if (status === "SUCCESS") return COLOR_LOW;
  if (status === "FAILED") return COLOR_HOT;
  if (ACTIVE_STATUSES.has(status)) return COLOR_MED;
  if (status === "CANCELED" || status === "SKIPPED" || status === "MANUAL") return COLOR_IDLE;
  return GREEN;
}

export function statusGlyph(status) {
  if (status === "SUCCESS") return "OK";
  if (status === "FAILED") return "ER";
  if (ACTIVE_STATUSES.has(status)) return "..";
  if (status === "CANCELED") return "C";
  if (status === "SKIPPED") return "S";
  if (status === "MANUAL") return "M";
  return "?";
}

/**
 * Render a single pipeline row at vertical position `y`.
 * `glyph`/`glyphColor`/`ageColor` override the defaults so the same
 * helper covers both "recent" (status-derived color) and "active"
 * (fixed amber) variants.
 */
export function pipelineRow({ y, glyph, glyphColor, project, ref, age, ageColor = GREEN, refX = 139 }) {
  return `
      <text x="13"  y="${y}" font-size="11" fill="${glyphColor}" font-weight="700">${escapeXml(glyph)}</text>
      <text x="32"  y="${y}" font-size="11" fill="${GREEN}">${escapeXml(project)}</text>
      <text x="${refX}" y="${y}" font-size="11" fill="${GREEN}">${escapeXml(ref)}</text>
      <text x="231" y="${y}" font-size="11" fill="${ageColor}" text-anchor="end">${escapeXml(age)}</text>
  `;
}
