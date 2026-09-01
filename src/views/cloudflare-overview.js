/**
 * Cloudflare zones slide — paginated list of ALL zones, today's request count
 * + 5xx rate per zone. Sorted by traffic descending so busiest leads.
 *
 * Multiple slideshow entries point to this single view, each passing a
 * different `cloudflarePage` index in state — see views/index.js.
 *
 * Layout fits 7 zones per page within the y<=108 safe zone.
 */
import {
  GREEN, DIM, BRIGHT, COLOR_LOW, COLOR_MED, COLOR_HOT,
  header, watermark, frameSvg, svgToStaticGif, nowLabelLocal, formatTokens,
} from "./_shared.js";
import { fetchOverview } from "../integrations/cloudflare.js";

export const ZONES_PER_PAGE = 6;

function errorRateColor(pct) {
  if (pct < 0.5) return COLOR_LOW;
  if (pct < 2.0) return COLOR_MED;
  return COLOR_HOT;
}

function truncateName(name, max = 22) {
  if (name.length <= max) return name;
  return name.slice(0, max - 1) + "…";
}

function escapeXml(s) {
  return String(s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

async function renderForPage(state, pageIndex = 0) {
  const nowLabel = state?.nowLabel || nowLabelLocal();
  const data = await fetchOverview();
  const allZones = data.zones || [];
  const totalPages = Math.max(1, Math.ceil(allZones.length / ZONES_PER_PAGE));
  const safePage = Math.min(pageIndex, totalPages - 1);
  const slice = allZones.slice(safePage * ZONES_PER_PAGE, (safePage + 1) * ZONES_PER_PAGE);

  const subheadLeft = "ZONES TODAY";
  const subheadRight = `PAGE ${safePage + 1}/${totalPages}`;

  const rows = slice.map((z, i) => {
    const y = 41 + i * 12;
    const reqStr = formatTokens(z.requests);
    const errStr = `${z.errorRate.toFixed(1)}%`;
    const ec = errorRateColor(z.errorRate);
    return `
      <text x="13"  y="${y}" font-size="11" fill="${GREEN}">${escapeXml(truncateName(z.name))}</text>
      <text x="192" y="${y}" font-size="11" fill="${GREEN}" text-anchor="end">${escapeXml(reqStr)}</text>
      <text x="231" y="${y}" font-size="11" fill="${ec}" text-anchor="end">${escapeXml(errStr)}</text>
    `;
  }).join("\n");

  const emptyRow = slice.length === 0
    ? `<text x="120" y="60" font-size="11" fill="${GREEN}" text-anchor="middle">no zones</text>`
    : "";

  const body = `
    ${header({ title: "CLOUDFLARE", nowLabel, bold: state?.paused })}
    <text x="13"  y="29" font-size="10" fill="${GREEN}">${escapeXml(subheadLeft)}</text>
    <text x="231" y="29" font-size="10" fill="${GREEN}" text-anchor="end">${escapeXml(subheadRight)}</text>
    ${rows}
    ${emptyRow}
    ${watermark()}
  `;
  return svgToStaticGif(frameSvg(body));
}

// Default export — page 0 if called directly without page state.
export async function render(state) {
  return renderForPage(state, state?.cloudflarePage ?? 0);
}

/** Factory: returns a slideshow-entry shape for a specific page. */
export function makeCloudflarePage(pageIndex) {
  return {
    id: `cloudflare-zones-${pageIndex + 1}`,
    name: `Cloudflare Zones · Page ${pageIndex + 1}`,
    render: (state) => renderForPage(state, pageIndex),
  };
}

export default { id: "cloudflare-overview", name: "Cloudflare Overview", render };
