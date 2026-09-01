import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const SETTINGS = path.join(os.homedir(), ".claude", "settings.json");
const URL_FRAGMENT = "http://127.0.0.1:"; // matches any port we picked
const ROUTE_TAGS = ["/tool", "/session/start", "/session/stop"];

function isOurCommand(cmd) {
  if (typeof cmd !== "string") return false;
  if (!cmd.includes(URL_FRAGMENT)) return false;
  return ROUTE_TAGS.some((r) => cmd.includes(r));
}

function strip(settings) {
  if (!settings.hooks) return;
  for (const event of Object.keys(settings.hooks)) {
    const entries = settings.hooks[event];
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (!entry.hooks) continue;
      entry.hooks = entry.hooks.filter((h) => !isOurCommand(h.command));
    }
    settings.hooks[event] = entries.filter((e) => e.hooks && e.hooks.length > 0);
    if (settings.hooks[event].length === 0) delete settings.hooks[event];
  }
  if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
}

async function main() {
  let raw = "{}";
  try { raw = await readFile(SETTINGS, "utf8"); } catch {
    console.log("settings.json not found — nothing to uninstall");
    return;
  }
  const settings = JSON.parse(raw);
  strip(settings);
  await writeFile(SETTINGS, JSON.stringify(settings, null, 2));
  console.log("✓ removed claude-stats-daemon hooks from settings.json");
}

main().catch((err) => {
  console.error("uninstall-hook failed:", err);
  process.exit(1);
});
