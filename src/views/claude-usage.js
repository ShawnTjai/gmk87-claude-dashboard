/**
 * Slot 0 view (locked v1.0.0 layout): Claude Code token + cost + rate-limit dashboard.
 *
 * Renderer is pure: state → SVG → static GIF. The daemon owns when/how often
 * to call render(); it just gives us the data.
 */
import {
  W, GREEN, DIM, formatTokens, intensityColor,
  header, watermark, frameSvg, svgToStaticGif, nowLabelLocal,
} from "./_shared.js";

const id = "claude-usage";

function labelledBarSvg({ label, pct, x, y, w, barH = 14 }) {
  const LABEL_W = 22;
  const VALUE_W = 38;
  const barX = x + LABEL_W;
  const barW = w - LABEL_W - VALUE_W;
  const validPct = Number.isFinite(pct) ? Math.max(0, Math.min(100, pct)) : null;
  const fillColor = validPct === null ? DIM : intensityColor(validPct);
  const valueText = validPct === null ? "—" : `${Math.round(validPct)}%`;
  const fillW = validPct === null ? 0 : Math.round((validPct / 100) * (barW - 4));
  const textY = y + barH - 3;
  return `
    <text x="${x}" y="${textY}" font-size="12" fill="${GREEN}" font-weight="700">${label}</text>
    <rect x="${barX}" y="${y}" width="${barW}" height="${barH}" fill="none" stroke="${DIM}" stroke-width="1"/>
    <rect x="${barX + 2}" y="${y + 2}" width="${fillW}" height="${barH - 4}" fill="${fillColor}"/>
    <text x="${x + w}" y="${textY}" font-size="12" fill="${fillColor}" text-anchor="end" font-weight="700">${valueText}</text>
  `;
}

export function render(state) {
  const {
    tokensTotal = 0,
    cost = 0,
    lifetimeTokens = 0,
    lifetimeCost = 0,
    intensity = 0,
    nowLabel = nowLabelLocal(),
    fiveHourPct = null,
    sevenDayPct = null,
  } = state || {};

  const leftCenter = 60;
  const rightCenter = 180;

  const body = `
    ${header({ title: "CLAUDE CODE USAGE", nowLabel, bold: state?.paused })}
    <line x1="120" y1="22" x2="120" y2="66" stroke="${DIM}" stroke-opacity="0.5" stroke-width="1"/>

    <text x="${leftCenter}"  y="28" font-size="9" text-anchor="middle" fill="${GREEN}">TODAY</text>
    <text x="${rightCenter}" y="28" font-size="9" text-anchor="middle" fill="${GREEN}">ALL TIME</text>

    <text x="${leftCenter}"  y="48" font-size="22" text-anchor="middle" filter="url(#glow)" font-weight="700">${formatTokens(tokensTotal)}</text>
    <text x="${rightCenter}" y="48" font-size="22" text-anchor="middle" filter="url(#glow)" font-weight="700">${formatTokens(lifetimeTokens)}</text>

    <text x="${leftCenter}"  y="64" font-size="11" text-anchor="middle">$${cost.toFixed(2)}</text>
    <text x="${rightCenter}" y="64" font-size="11" text-anchor="middle">$${lifetimeCost.toFixed(2)}</text>

    ${labelledBarSvg({ label: "5H", pct: fiveHourPct, x: 14, y: 72, w: 212 })}
    ${labelledBarSvg({ label: "7D", pct: sevenDayPct, x: 14, y: 90, w: 212 })}

    ${watermark()}
  `;
  return svgToStaticGif(frameSvg(body));
}

export default { id, name: "Claude Code Usage", render };
