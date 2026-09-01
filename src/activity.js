import { readdir, stat } from "node:fs/promises";
import path from "node:path";

const HALF_LIFE_MS = 10_000;
const DECAY_PER_MS = Math.log(2) / HALF_LIFE_MS;

export function bucketFor(intensity) {
  if (intensity < 20) return "idle";
  if (intensity < 50) return "low";
  if (intensity < 80) return "med";
  return "hot";
}

export class ActivityTracker {
  constructor({ clock = () => Date.now() } = {}) {
    this.clock = clock;
    this.toolRate = 0;
    this.sessionCount = 0;
    this.lastTick = clock();
  }
  recordToolUse() {
    this.tick();
    this.toolRate += 1;
  }
  setSessionCount(n) {
    this.sessionCount = n;
  }
  tick() {
    const now = this.clock();
    const elapsed = now - this.lastTick;
    if (elapsed > 0) {
      this.toolRate *= Math.exp(-DECAY_PER_MS * elapsed);
    }
    this.lastTick = now;
  }
  get intensity() {
    return Math.min(100, Math.round(this.sessionCount * 30 + this.toolRate * 15));
  }
  get bucket() {
    return bucketFor(this.intensity);
  }
}

export async function scanActiveSessions(projectsDir, windowMs) {
  const cutoff = Date.now() - windowMs;
  let count = 0;
  async function walk(dir) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        try {
          const s = await stat(full);
          if (s.mtimeMs >= cutoff) count++;
        } catch {}
      }
    }
  }
  await walk(projectsDir);
  return count;
}
