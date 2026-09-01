/**
 * UptimeRobot slide — dual-mode:
 *
 * 1. ALL ONLINE — ASCII smiley + count of monitored services. Renders as
 *    part of the normal slideshow rotation.
 * 2. SERVICE DOWN — list of down services with how long each has been down.
 *    Returns priority()=true so the slideshow runner pins this slide over
 *    everything else until the outage resolves.
 */
import {
  GREEN, BRIGHT, COLOR_HOT, COLOR_LOW,
  header, watermark, frameSvg, svgToStaticGif, nowLabelLocal,
} from "./_shared.js";
import { fetchMonitors } from "../integrations/uptimerobot.js";
import { escapeXml, truncate } from "./_pipeline-row.js";

const DOWN_ROWS = 4;

// Pagination state for the down-services list. Persists between renders so
// each slideshow tick (5s) advances the visible page. Reset whenever the
// set of down services changes (resolved or newly-down) so the user sees
// page 1 immediately when the outage picture shifts.
let downPageIdx = 0;
let lastDownSig = "";

function durationLabel(seconds) {
  if (seconds == null) return "—";
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    return m === 0 ? `${h}h` : `${h}h${m}m`;
  }
  return `${Math.floor(seconds / 86400)}d`;
}

// Strip protocol + trailing slash so the name fits more usefully.
function shortenName(name) {
  if (!name) return "";
  return name.replace(/^https?:\/\//, "").replace(/\/$/, "");
}

function renderAllOnline(upCount, pausedCount, nowLabel, bold) {
  const pausedNote = pausedCount > 0 ? ` · ${pausedCount} paused` : "";
  // System emoji fonts so the smiley renders as a real glyph instead of "?".
  // Sharp/librsvg picks up Segoe UI Emoji on Windows via fontconfig fallback.
  const emojiFonts = "Segoe UI Emoji, Apple Color Emoji, Twemoji Mozilla, Noto Color Emoji, sans-serif";
  return `
    ${header({ title: "UPTIME · MONITOR", nowLabel, bold: bold })}
    <text x="120" y="56" font-size="36" text-anchor="middle" font-family="${emojiFonts}">🙂</text>
    <text x="120" y="82" font-size="18" text-anchor="middle" fill="${BRIGHT}" font-weight="700">ALL ONLINE</text>
    <text x="120" y="97" font-size="12" text-anchor="middle" fill="${GREEN}">${upCount} service${upCount === 1 ? "" : "s"}${pausedNote}</text>
    ${watermark()}
  `;
}

function renderDown(downServices, totalCount, nowLabel, bold) {
  const totalPages = Math.max(1, Math.ceil(downServices.length / DOWN_ROWS));

  // Reset paging when the set of down services changes; otherwise advance
  // one page per render so the user sees every overflowed entry over time.
  // When the slideshow is paused (bold=true), freeze the page too — locking
  // a slide should lock its pagination state, not just the outer rotation.
  const sig = downServices.map((s) => s.id).join(",");
  if (sig !== lastDownSig) {
    downPageIdx = 0;
    lastDownSig = sig;
  }
  const safePage = downPageIdx % totalPages;
  const slice = downServices.slice(safePage * DOWN_ROWS, (safePage + 1) * DOWN_ROWS);
  if (!bold) downPageIdx = (downPageIdx + 1) % totalPages;

  // When paginated, drop the first row down to make room for a centered
  // PAGE indicator just below the headline. Otherwise rows start tight to
  // the headline as before.
  const firstRowY = totalPages > 1 ? 62 : 53;
  const rows = slice.map((s, i) => {
    const y = firstRowY + i * 14;
    const name = truncate(shortenName(s.name), 22);
    const dur = durationLabel(s.downForSeconds);
    return `
      <text x="13"  y="${y}" font-size="15" fill="${COLOR_HOT}" font-weight="700">${escapeXml(name)}</text>
      <text x="231" y="${y}" font-size="15" fill="${COLOR_HOT}" text-anchor="end" font-weight="700">${escapeXml(dur)}</text>
    `;
  }).join("\n");

  const headline = `${downServices.length}/${totalCount} SERVICES DOWN`;
  const pageIndicator = totalPages > 1
    ? `<text x="120" y="49" font-size="10" text-anchor="middle" fill="${COLOR_HOT}" font-weight="700">PAGE ${safePage + 1}/${totalPages}</text>`
    : "";

  return `
    ${header({ title: "UPTIME · ALERT", nowLabel, bold: bold })}
    <text x="120" y="35" font-size="18" text-anchor="middle" fill="${COLOR_HOT}" font-weight="700">${escapeXml(headline)}</text>
    ${pageIndicator}
    ${rows}
    ${watermark()}
  `;
}

export async function render(state) {
  const nowLabel = state?.nowLabel || nowLabelLocal();
  const data = await fetchMonitors();
  const body = data.downCount > 0
    ? renderDown(data.downServices, data.totalCount, nowLabel, state?.paused)
    : renderAllOnline(data.upCount, data.pausedCount, nowLabel, state?.paused);
  return svgToStaticGif(frameSvg(body));
}

/**
 * priority(state) === true → slideshow runner pins this view until it returns false.
 * Used here to interrupt the rotation when any monitored service is down.
 */
export async function priority() {
  try {
    const data = await fetchMonitors();
    return data.downCount > 0;
  } catch {
    return false;
  }
}

export default { id: "uptimerobot", name: "UptimeRobot", render, priority };
