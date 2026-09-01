/**
 * Lighting feedback for daemon state — drives both the side-LED (pause)
 * and the keyboard underglow (uptime alert).
 *
 * Side LED (small light right of PgDn, cycled via Fn+PgUp/PgDn):
 *   - LOCKED  → solid red    (FIXED_COLOR)
 *   - AUTO    → rainbow breathing (PULSE_RAINBOW)
 *
 * Underglow (the side glow visible from the keyboard's edges):
 *   - OUTAGE  → breathing red, full brightness
 *   - HEALTHY → restore whatever was set when the daemon started
 *
 * Why this and not the header text alone: VT323 has no bold weight, so an
 * SVG font-weight=700 would be a no-op visually. Lighting changes are also
 * a small HID config write (~100 ms) vs the ~5 s image upload, so the user
 * gets near-instant feedback for fast-changing state.
 *
 * Concurrency note: gmk87.setLighting and gmk87.uploadImage both open the
 * device's custom HID interface (usagePage 0xff1c). We make no attempt to
 * coordinate — node-hid serialises at the OS level and the firmware accepts
 * lighting commands interleaved with image uploads in practice. If a clash
 * ever corrupts an upload, we'd add a shared lock.
 */
import gmk87 from "gmk87-node";

// ---- Big-LED modes (LED_MODES enum from gmk87-node) ----
const LED_MODE_BREATHING = 0x01; // PULSE_RAINBOW — rainbow breathing (default/auto)
const LED_MODE_SOLID     = 0x03; // FIXED_COLOR
const LED_COLOR_RED      = 0x00; // LED_COLORS.RED

// ---- Underglow effects ----
const UG_EFFECT_BREATHING = 0x05; // BREATHING — single-color smooth pulse

let currentLocked  = null;        // last LED state we wrote (null = never written)
let currentOutage  = null;        // last underglow alert state
let underglowBaseline = null;     // captured at daemon boot so we can restore

// ---- LED (pause indicator) ----

export async function setLockedLed(locked) {
  if (locked === currentLocked) return;
  try {
    await gmk87.setLighting({
      led: {
        mode: locked ? LED_MODE_SOLID : LED_MODE_BREATHING,
        color: LED_COLOR_RED,
      },
    });
    currentLocked = locked;
  } catch (e) {
    console.warn(`[daemon] LED ${locked ? "lock" : "unlock"} failed:`, e.message);
  }
}

// ---- Underglow (uptime alert) ----

/**
 * Read the keyboard's current underglow config so we can restore it when an
 * outage resolves. Call once at daemon startup BEFORE any underglow override.
 * Silently no-ops on failure; we'll just leave the keyboard alone on restore.
 */
export async function captureUnderglowBaseline() {
  try {
    const cfg = await gmk87.readConfig();
    // gmk87-node parses underglow into a usable object — keep the whole thing.
    underglowBaseline = { ...cfg.underglow };
  } catch (e) {
    console.warn("[daemon] underglow baseline capture failed:", e.message);
  }
}

/**
 * `hasOutage=true` → switch underglow to breathing red.
 * `hasOutage=false` → restore the captured baseline (or no-op if baseline missing).
 */
export async function setOutageUnderglow(hasOutage) {
  if (hasOutage === currentOutage) return;
  try {
    if (hasOutage) {
      await gmk87.setLighting({
        underglow: {
          effect: UG_EFFECT_BREATHING,
          brightness: 9,
          speed: 3,
          rainbow: 0,                 // single-color, not rainbow
          hue: { red: 255, green: 0, blue: 0 },
        },
      });
    } else if (underglowBaseline) {
      await gmk87.setLighting({ underglow: underglowBaseline });
    }
    currentOutage = hasOutage;
  } catch (e) {
    console.warn(`[daemon] underglow ${hasOutage ? "alert" : "restore"} failed:`, e.message);
  }
}
