/**
 * GitHub "active right now" slide — same shape as gitlab-active, but pulls
 * from the GitHub Actions integration. Hides itself when nothing's running.
 */
import {
  GREEN, COLOR_LOW, COLOR_MED,
  header, watermark, frameSvg, svgToStaticGif, nowLabelLocal,
} from "./_shared.js";
import { fetchPipelineActivity } from "../integrations/github.js";
import { shortProject, truncate, ageLabel, escapeXml, pipelineRow } from "./_pipeline-row.js";

const ROWS = 6;

export async function render(state) {
  const nowLabel = state?.nowLabel || nowLabelLocal();
  const data = await fetchPipelineActivity();
  const rows = (data.active || []).slice(0, ROWS);

  const rowSvg = rows.map((p, i) => pipelineRow({
    y: 41 + i * 12,
    glyph: "..",
    glyphColor: COLOR_MED,
    project: shortProject(p.project),
    ref: truncate(p.ref, 10),
    age: ageLabel(p.ageSeconds),
    ageColor: COLOR_MED,
    refX: 151,
  })).join("\n");

  const emptyRow = rows.length === 0
    ? `<text x="120" y="62" font-size="14" fill="${COLOR_LOW}" text-anchor="middle" font-weight="700">all clear</text>`
    : "";

  const subheadRight = `${rows.length} ACTIVE`;

  const body = `
    ${header({ title: "GITHUB · IN FLIGHT", nowLabel, bold: state?.paused })}
    <text x="13"  y="29" font-size="10" fill="${GREEN}">WORKFLOWS</text>
    <text x="231" y="29" font-size="10" fill="${GREEN}" text-anchor="end">${escapeXml(subheadRight)}</text>
    ${rowSvg}
    ${emptyRow}
    ${watermark()}
  `;
  return svgToStaticGif(frameSvg(body));
}

export async function shouldShow() {
  const data = await fetchPipelineActivity();
  return (data.active || []).length > 0;
}

export default { id: "github-active", name: "GitHub Active Workflows", render, shouldShow };
