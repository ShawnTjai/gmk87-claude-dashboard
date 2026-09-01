// Shared rendering primitives used across views. Keep colors/sizes consistent.
import sharp from "sharp";
import GIFEncoder from "gif-encoder-2";

export const W = 240;
export const H = 135;
export const SAFE_BOTTOM = 108; // anything below this is hard to read at the keyboard's viewing angle

export const GREEN  = "#33ff66";
export const BRIGHT = "#a0ffba";
export const DIM    = "#1a8033";
export const BG     = "#000000";

// Bucket colors (cyan/green/amber/red) — used by any view that displays an intensity.
export const COLOR_IDLE = "#33ccff";
export const COLOR_LOW  = "#33ff66";
export const COLOR_MED  = "#ffcc33";
export const COLOR_HOT  = "#ff0000";

export function intensityColor(intensity) {
  if (intensity < 20) return COLOR_IDLE;
  if (intensity < 50) return COLOR_LOW;
  if (intensity < 80) return COLOR_MED;
  return COLOR_HOT;
}

export function formatTokens(n) {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return (n / 1_000).toFixed(1).replace(/\.0$/, "") + "K";
  if (n < 1_000_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M";
  return (n / 1_000_000_000).toFixed(1).replace(/\.0$/, "") + "B";
}

// Common header bar: title left, time right, horizontal divider underneath.
// `bold` (kept as the param name for view back-compat) means "the slideshow
// is locked": we prepend a 🔒 emoji to the title since VT323 has no bold
// weight so font-weight=700 is a no-op visually.
export function header({ title, nowLabel, bold = false }) {
  const emojiFonts = "Segoe UI Emoji, Apple Color Emoji, Twemoji Mozilla, Noto Color Emoji, sans-serif";
  // 🔒 rendered slightly larger than the title text so it's noticeable at the
  // keyboard's 240×135 native resolution where 11px glyphs are tiny.
  const lockIcon = bold
    ? `<text x="4" y="13" font-size="13" font-family="${emojiFonts}" fill="${GREEN}">🔒</text>`
    : "";
  const titleX = bold ? 22 : 6;
  return `
    ${lockIcon}
    <text x="${titleX}"   y="12" font-size="11" fill="${GREEN}">${title}</text>
    <text x="234" y="12" font-size="11" text-anchor="end" fill="${GREEN}">${nowLabel}</text>
    <line x1="0" y1="17" x2="${W}" y2="17" stroke="${DIM}" stroke-width="1" stroke-opacity="0.6"/>
  `;
}

export function watermark() {
  return `<text x="${W / 2}" y="125" font-size="12" text-anchor="middle" fill="${GREEN}">@ShawnTjai</text>`;
}

// Wrap an inner SVG body in the standard frame.
export function frameSvg(innerBody) {
  return `<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">
  <defs>
    <filter id="glow" x="-50%" y="-50%" width="200%" height="200%">
      <feGaussianBlur stdDeviation="1.0"/>
      <feMerge><feMergeNode/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
  </defs>
  <rect width="${W}" height="${H}" fill="${BG}"/>
  <g font-family="VT323, 'Cascadia Mono', monospace" fill="${GREEN}">
    ${innerBody}
  </g>
</svg>`;
}

export async function svgToStaticGif(svg) {
  const png = await sharp(Buffer.from(svg)).resize(W, H, { fit: "fill" }).png().toBuffer();
  const raw = await sharp(png).raw().toBuffer();
  const encoder = new GIFEncoder(W, H, "neuquant", true);
  encoder.start();
  encoder.setRepeat(0);
  encoder.setDelay(1000);
  encoder.setQuality(10);
  encoder.addFrame(raw);
  encoder.finish();
  return encoder.out.getData();
}

export function nowLabelLocal() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
