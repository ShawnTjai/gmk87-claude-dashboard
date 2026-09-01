import { test } from "node:test";
import assert from "node:assert/strict";
import { startHookServer } from "../src/hook-server.js";

async function post(url) {
  const res = await fetch(url, { method: "POST" });
  return { status: res.status };
}

test("hook server binds to 127.0.0.1 only", async () => {
  const events = [];
  const server = await startHookServer({
    preferredPort: 0,
    onEvent: (type) => events.push(type),
  });
  assert.equal(server.address().address, "127.0.0.1");
  await server.closeAsync();
});

test("hook server records tool/session events and ignores others", async () => {
  const events = [];
  const server = await startHookServer({
    preferredPort: 0,
    onEvent: (type) => events.push(type),
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await post(`${base}/tool`)).status, 204);
  assert.equal((await post(`${base}/session/start`)).status, 204);
  assert.equal((await post(`${base}/session/stop`)).status, 204);
  assert.equal((await post(`${base}/garbage`)).status, 404);
  assert.deepEqual(events, ["tool", "session-start", "session-stop"]);
  await server.closeAsync();
});
