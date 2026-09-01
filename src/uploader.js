import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import gmk87 from "gmk87-node";

const TMP_DIR = path.join(os.tmpdir(), "claude-stats-daemon");
const SLOT0_PATH = path.join(TMP_DIR, "slot0.gif");
const SLOT1_PATH = path.join(TMP_DIR, "slot1.gif");

let tmpReady = false;
async function ensureTmp() {
  if (tmpReady) return;
  await mkdir(TMP_DIR, { recursive: true });
  tmpReady = true;
}

let slot0Ready = false;
let slot1Ready = false;

/**
 * Read whichever slot the keyboard is currently displaying.
 * Returns 0 (built-in clock), 1 (slot 0 image), or 2 (slot 1 image).
 */
export async function getCurrentDisplaySlot() {
  const cfg = await gmk87.readConfig();
  return cfg.showImage;
}

/**
 * Upload both slot images and explicitly set which one to display afterwards.
 *
 * `showSlot` is required and must be 0 / 1 / 2:
 *   0 — built-in clock face
 *   1 — slot 0 image (CLAUDE CODE USAGE)
 *   2 — slot 1 image (rotating ops dashboard)
 *
 * Why explicit: gmk87-node's `showAfter:false` doesn't preserve the current
 * selection — it resets the keyboard to the clock. To respect the user's
 * Fn+Enter selection, the caller reads the current slot first then passes
 * it back here.
 */
export async function uploadSlots({ slot0Buffer = null, slot1Buffer = null, showSlot, frameDuration = 1000 } = {}) {
  if (showSlot === undefined || showSlot === null) {
    throw new Error("uploadSlots requires explicit showSlot (0, 1, or 2)");
  }
  await ensureTmp();
  if (slot0Buffer) { await writeFile(SLOT0_PATH, slot0Buffer); slot0Ready = true; }
  if (slot1Buffer) { await writeFile(SLOT1_PATH, slot1Buffer); slot1Ready = true; }
  if (!slot0Ready || !slot1Ready) {
    throw new Error("uploadSlots needs both slots seeded; pass both buffers on first call");
  }

  if (showSlot === 0) {
    // Want the clock displayed — gmk87-node's showAfter:false does exactly that.
    await gmk87.uploadImage(SLOT0_PATH, 0, {
      slot0File: SLOT0_PATH,
      slot1File: SLOT1_PATH,
      frameDuration,
      showAfter: false,
    });
  } else {
    // Want slot 0 (showSlot=1) or slot 1 (showSlot=2). gmk87-node displays
    // slot `imageIndex + 1` when showAfter:true, so imageIndex = showSlot - 1.
    await gmk87.uploadImage(SLOT0_PATH, showSlot - 1, {
      slot0File: SLOT0_PATH,
      slot1File: SLOT1_PATH,
      frameDuration,
      showAfter: true,
    });
  }
}

export async function showSlot(slot) {
  await gmk87.setLighting({ showImage: slot });
}

export async function revertToTime() {
  await gmk87.setLighting({ showImage: 0 });
}
