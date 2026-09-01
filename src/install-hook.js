import { readFile, writeFile, copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const SETTINGS = path.join(os.homedir(), ".claude", "settings.json");
const PORT_FILE = path.resolve(".runtime", "port");

async function readPort() {
  try {
    const txt = await readFile(PORT_FILE, "utf8");
    const n = parseInt(txt, 10);
    return Number.isFinite(n) ? n : 8787;
  } catch {
    return 8787;
  }
}

function hookCmd(port, route) {
  return `curl -s -m 1 -X POST http://127.0.0.1:${port}${route} || exit 0`;
}

function ensureHook(settings, eventName, command) {
  settings.hooks = settings.hooks || {};
  const list = (settings.hooks[eventName] = settings.hooks[eventName] || []);
  for (const entry of list) {
    if (!entry.hooks) continue;
    for (const h of entry.hooks) {
      if (h.type === "command" && h.command === command) return; // already present
    }
  }
  list.push({
    matcher: ".*",
    hooks: [{ type: "command", command }],
  });
}

async function main() {
  const port = await readPort();
  let raw = "{}";
  try { raw = await readFile(SETTINGS, "utf8"); } catch {}
  const settings = JSON.parse(raw);

  const backup = `${SETTINGS}.bak-${Date.now()}`;
  await mkdir(path.dirname(backup), { recursive: true });
  try { await copyFile(SETTINGS, backup); } catch {}
  ensureHook(settings, "PostToolUse", hookCmd(port, "/tool"));
  ensureHook(settings, "SessionStart", hookCmd(port, "/session/start"));
  ensureHook(settings, "Stop",         hookCmd(port, "/session/stop"));

  await writeFile(SETTINGS, JSON.stringify(settings, null, 2));
  console.log(`✓ installed hooks → settings.json (port ${port})`);
  console.log(`✓ backup: ${backup}`);
}

main().catch((err) => {
  console.error("install-hook failed:", err);
  process.exit(1);
});
