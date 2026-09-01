/**
 * GitLab "recent activity" slide — paginated last N pipelines across all
 * your projects, any status, sorted by updatedAt desc. Each row colored by
 * status bucket. Layout mirrors cloudflare-overview.
 */
import { GREEN, header, watermark, frameSvg, svgToStaticGif, nowLabelLocal } from "./_shared.js";
import { fetchPipelineActivity } from "../integrations/gitlab.js";
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
  })).join("\n");

  const emptyRow = rows.length === 0
    ? `<text x="120" y="60" font-size="11" fill="${GREEN}" text-anchor="middle">${data.error ? "gitlab: " + escapeXml(data.error.slice(0, 30)) : "no pipelines"}</text>`
    : "";

  const subheadRight = `PAGE ${safePage + 1}/${totalPages}`;

  const body = `
    ${header({ title: "GITLAB · RECENT", nowLabel, bold: state?.paused })}
    <text x="13"  y="29" font-size="10" fill="${GREEN}">PIPELINES</text>
    <text x="231" y="29" font-size="10" fill="${GREEN}" text-anchor="end">${escapeXml(subheadRight)}</text>
    ${rowSvg}
    ${emptyRow}
    ${watermark()}
  `;
  return svgToStaticGif(frameSvg(body));
}

export async function render(state) {
  return renderForPage(state, state?.gitlabRecentPage ?? 0);
}

export function makeGitlabRecentPage(pageIndex) {
  return {
    id: `gitlab-recent-${pageIndex + 1}`,
    name: `GitLab Recent · Page ${pageIndex + 1}`,
    render: (state) => renderForPage(state, pageIndex),
  };
}

export default { id: "gitlab-recent", name: "GitLab Recent Pipelines", render };
