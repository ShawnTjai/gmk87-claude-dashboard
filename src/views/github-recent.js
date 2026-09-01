/**
 * GitHub "recent activity" slide — paginated last N workflow runs, sorted by
 * updatedAt desc. Status-bucket colored. Same layout as gitlab-recent.
 */
import { GREEN, header, watermark, frameSvg, svgToStaticGif, nowLabelLocal } from "./_shared.js";
import { fetchPipelineActivity } from "../integrations/github.js";
import {
  shortProject, truncate, ageLabel, escapeXml,
  statusColor, statusGlyph, pipelineRow,
} from "./_pipeline-row.js";

export const ROWS_PER_PAGE = 6;

async function renderForPage(state, pageIndex = 0) {
  const nowLabel = state?.nowLabel || nowLabelLocal();
  const data = await fetchPipelineActivity();
  const all = data.recent || [];
  const totalPages = Math.max(1, Math.ceil(all.length / ROWS_PER_PAGE));
  const safePage = Math.min(pageIndex, totalPages - 1);
  const rows = all.slice(safePage * ROWS_PER_PAGE, (safePage + 1) * ROWS_PER_PAGE);

  const rowSvg = rows.map((p, i) => pipelineRow({
    y: 41 + i * 12,
    glyph: statusGlyph(p.status),
    glyphColor: statusColor(p.status),
    project: shortProject(p.project),
    ref: truncate(p.ref, 10),
    age: ageLabel(p.ageSeconds),
    refX: 151,
  })).join("\n");

  const emptyRow = rows.length === 0
    ? `<text x="120" y="60" font-size="11" fill="${GREEN}" text-anchor="middle">${data.error ? "github: " + escapeXml(data.error.slice(0, 30)) : "no workflows"}</text>`
    : "";

  const subheadRight = `PAGE ${safePage + 1}/${totalPages}`;

  const body = `
    ${header({ title: "GITHUB · RECENT", nowLabel, bold: state?.paused })}
    <text x="13"  y="29" font-size="10" fill="${GREEN}">WORKFLOWS</text>
    <text x="231" y="29" font-size="10" fill="${GREEN}" text-anchor="end">${escapeXml(subheadRight)}</text>
    ${rowSvg}
    ${emptyRow}
    ${watermark()}
  `;
  return svgToStaticGif(frameSvg(body));
}

// Hide entirely when there's nothing to show — keeps the slideshow from
// dwelling on a blank "no workflows" slide if the user has no Actions yet.
export async function shouldShow() {
  const data = await fetchPipelineActivity();
  return (data.recent || []).length > 0;
}

export async function render(state) {
  return renderForPage(state, state?.githubRecentPage ?? 0);
}

export function makeGithubRecentPage(pageIndex) {
  return {
    id: `github-recent-${pageIndex + 1}`,
    name: `GitHub Recent · Page ${pageIndex + 1}`,
    render: (state) => renderForPage(state, pageIndex),
    shouldShow,
  };
}

export default { id: "github-recent", name: "GitHub Recent Workflows", render, shouldShow };
