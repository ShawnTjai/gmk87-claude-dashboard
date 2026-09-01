/**
 * Coding Activity Today — per-project token + cost breakdown for the current
 * local day. Reads from state.byProject (sorted desc by tokens) which the
 * daemon aggregates from transcript files in ~/.claude/projects/.
 *
 * Project hashes are Claude Code's "path-with-slashes-as-hyphens" encoding,
 * e.g. "C--Users-Foo-Desktop-Projects-MyProj". We walk back from the leaf
 * accumulating hyphen-separated segments until the column width budget runs
 * out — usually recovers the real leaf+immediate-parent. Org abbreviations
 * (AcmeCorp->AC, etc) are applied first so more context fits.
 */
import { GREEN, COLOR_HOT, header, watermark, frameSvg, svgToStaticGif, nowLabelLocal, formatTokens } from "./_shared.js";
import { applyAbbreviations, escapeXml } from "./_pipeline-row.js";

const ROWS = 6;

// Walk back from the leaf, accumulating hyphen-separated segments, until
// adding the next one would exceed `max`. Returns the longest trailing
// substring that fits.
function projectLabel(hash, max = 18) {
  if (!hash) return "";
  const abbreviated = applyAbbreviations(hash);
  const parts = abbreviated.split("-").filter(Boolean);
  if (parts.length === 0) return abbreviated.slice(0, max);
  let result = parts[parts.length - 1];
  for (let i = parts.length - 2; i >= 0; i--) {
    const candidate = parts[i] + "-" + result;
    if (candidate.length > max) break;
    result = candidate;
  }
  return result.length <= max ? result : result.slice(0, max - 1) + "…";
}

function formatMoney(cost) {
  if (cost < 0.01) return "<$0.01";
  if (cost >= 100) return `$${cost.toFixed(0)}`;
  return `$${cost.toFixed(2)}`;
}

export async function render(state) {
  const nowLabel = state?.nowLabel || nowLabelLocal();
  const projects = (state?.byProject || []).slice(0, ROWS);
  const sessions = state?.sessionsToday ?? 0;

  const rows = projects.map((p, i) => {
    const y = 41 + i * 12;
    const name = projectLabel(p.projectHash);
    const tokens = formatTokens(p.tokens_total);
    const money = formatMoney(p.cost);
    return `
      <text x="13"  y="${y}" font-size="11" fill="${GREEN}">${escapeXml(name)}</text>
      <text x="178" y="${y}" font-size="11" fill="${GREEN}" text-anchor="end">${escapeXml(tokens)}</text>
      <text x="231" y="${y}" font-size="11" fill="${GREEN}" text-anchor="end">${escapeXml(money)}</text>
    `;
  }).join("\n");

  const emptyRow = projects.length === 0
    ? `<text x="120" y="62" font-size="11" fill="${GREEN}" text-anchor="middle">no activity yet today</text>`
    : "";

  const subheadRight = `${sessions} SESSION${sessions === 1 ? "" : "S"}`;

  const body = `
    ${header({ title: "CODING TODAY", nowLabel, bold: state?.paused })}
    <text x="13"  y="29" font-size="10" fill="${GREEN}">PROJECT</text>
    <text x="231" y="29" font-size="10" fill="${GREEN}" text-anchor="end">${escapeXml(subheadRight)}</text>
    ${rows}
    ${emptyRow}
    ${watermark()}
  `;
  return svgToStaticGif(frameSvg(body));
}

// Hide if there's nothing to show — empty days look like a broken slide.
export async function shouldShow(state) {
  return (state?.byProject || []).length > 0;
}

export default { id: "coding-activity", name: "Coding Activity Today", render, shouldShow };
