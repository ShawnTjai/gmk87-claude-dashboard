import { createServer } from "node:http";

export async function startHookServer({ preferredPort = 8787, onEvent } = {}) {
  const handler = (req, res) => {
    if (req.method !== "POST") {
      res.statusCode = 405;
      return res.end();
    }
    const url = req.url || "";
    if (url === "/tool")              { onEvent?.("tool");          res.statusCode = 204; return res.end(); }
    if (url === "/session/start")     { onEvent?.("session-start"); res.statusCode = 204; return res.end(); }
    if (url === "/session/stop")      { onEvent?.("session-stop");  res.statusCode = 204; return res.end(); }
    res.statusCode = 404;
    res.end();
  };

  // Try preferredPort, then 8788-8799, then a random free one (0).
  const candidates = preferredPort === 0
    ? [0]
    : [preferredPort, ...Array.from({ length: 12 }, (_, i) => preferredPort + 1 + i), 0];

  for (const port of candidates) {
    try {
      const server = createServer(handler);
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", resolve);
      });
      server.closeAsync = () => new Promise((r) => server.close(r));
      return server;
    } catch (err) {
      if (err.code !== "EADDRINUSE") throw err;
    }
  }
  throw new Error("no free port for hook server");
}
