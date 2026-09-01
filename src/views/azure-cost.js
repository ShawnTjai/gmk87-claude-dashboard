/**
 * Azure cost view — month-to-date spend per subscription, summed across
 * all configured tenants.
 *
 * Layout: header / TOTAL row / per-sub rows (top 5 by cost; overflow rolled
 * into "+N more"). All content stays above y=108 (dead zone) except the
 * @ShawnTjai watermark at y=125.
 */
import { GREEN, DIM, BRIGHT, COLOR_MED, COLOR_HOT,
         header, watermark, frameSvg, svgToStaticGif, nowLabelLocal, W } from "./_shared.js";
import { fetchUsage } from "../integrations/azure.js";

const id = "azure-cost";

function formatMoney(amount, currency) {
  // Render as "USD 1,234.56" — keep the label inline so mixed currencies are
  // obvious (no false sense that everything's USD).
  return `${currency} ${Number(amount).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function totalsLine(byCurrency) {
  const parts = Object.entries(byCurrency).map(([cur, amt]) => formatMoney(amt, cur));
  if (parts.length === 0) return "—";
  if (parts.length === 1) return parts[0];
  // Multi-currency: show first + count of others
  return `${parts[0]}  +${parts.length - 1} cur`;
}

export async function render(state) {
  const nowLabel = state?.nowLabel || nowLabelLocal();
  const usage = await fetchUsage();
  const totalText = totalsLine(usage.byCurrency);

  // Sort by cost desc; keep top 5; collapse remainder into "+N more"
  const sortedSubs = [...usage.bySubscription].sort((a, b) => b.cost - a.cost);
  const MAX_VISIBLE = 5;
  const visible = sortedSubs.slice(0, MAX_VISIBLE);
  const hidden = sortedSubs.slice(MAX_VISIBLE);
  let extraRow = null;
  if (hidden.length) {
    // Aggregate hidden by their currency
    const sums = {};
    for (const s of hidden) sums[s.currency] = (sums[s.currency] || 0) + s.cost;
    const totalText = Object.entries(sums).map(([cur, amt]) => formatMoney(amt, cur)).join("  ");
    extraRow = { name: `+${hidden.length} more`, costText: totalText, error: false };
  }

  // Build rows: y starts at 46, +12px per row, max 5 rows ends y=94 (safe)
  // With overflow row, top 4 visible + overflow at y=94
  const rows = (extraRow ? visible.slice(0, MAX_VISIBLE - 1) : visible).map((sub, i) => {
    const y = 50 + i * 12;
    const costText = sub.error ? "—" : formatMoney(sub.cost, sub.currency);
    const color = sub.error ? COLOR_HOT : GREEN;
    return `
      <text x="14"  y="${y}" font-size="11" fill="${color}">${escapeXml(sub.name)}</text>
      <text x="226" y="${y}" font-size="11" fill="${color}" text-anchor="end">${escapeXml(costText)}</text>
    `;
  }).join("\n");
  const overflowSvg = extraRow
    ? (() => {
        const y = 50 + (MAX_VISIBLE - 1) * 12;
        return `
          <text x="14"  y="${y}" font-size="11" fill="${GREEN}">${escapeXml(extraRow.name)}</text>
          <text x="226" y="${y}" font-size="11" fill="${GREEN}" text-anchor="end">${escapeXml(extraRow.costText)}</text>
        `;
      })()
    : "";

  const body = `
    ${header({ title: `AZURE COST · MTD`, nowLabel, bold: state?.paused })}
    <text x="14"  y="33" font-size="14" fill="${GREEN}">TOTAL</text>
    <text x="226" y="33" font-size="14" text-anchor="end" fill="${BRIGHT}" font-weight="700">${escapeXml(totalText)}</text>
    <line x1="14" y1="38" x2="226" y2="38" stroke="${DIM}" stroke-width="1" stroke-opacity="0.5"/>
    ${rows}
    ${overflowSvg}
    ${watermark()}
  `;
  return svgToStaticGif(frameSvg(body));
}

function escapeXml(s) {
  return String(s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

export default { id, name: "Azure Cost (MTD)", render };
