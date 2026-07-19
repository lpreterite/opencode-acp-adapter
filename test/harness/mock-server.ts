import { createServer } from "node:http";
import { writeFileSync } from "node:fs";

const SESSIONS = new Map<string, { id: string; messages: any[]; completed: boolean }>();
const SSE_CLIENTS = new Set<any>();

const server = createServer((req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host}`);

  if (req.method === "POST" && url.pathname === "/session") {
    const id = `mock-sess-${SESSIONS.size + 1}`;
    SESSIONS.set(id, { id, messages: [], completed: false });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id }));
    return;
  }

  const sessionMatch = url.pathname.match(/^\/session\/([^/]+)\/message(?:\/([^/]+))?$/);
  if (sessionMatch) {
    const sessionId = sessionMatch[1];
    const msgId = sessionMatch[2];
    const session = SESSIONS.get(sessionId);

    if (req.method === "POST" && !msgId) {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const msg = JSON.parse(body);
        const id = `msg-${Date.now()}`;
        session?.messages.push({ id, ...msg });
        setTimeout(() => {
          if (session) session.completed = true;
        }, 200);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ info: { id }, parts: [] }));
      });
      return;
    }

    if (req.method === "GET" && msgId && session) {
      const completed = session.completed;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(completed ? { time: { completed: new Date().toISOString() } } : { time: {} }));
      return;
    }
  }

  const abortMatch = url.pathname.match(/^\/session\/([^/]+)\/abort$/);
  if (req.method === "POST" && abortMatch) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(true));
    return;
  }

  if (url.pathname === "/event") {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    SSE_CLIENTS.add(res);
    req.on("close", () => SSE_CLIENTS.delete(res));
    return;
  }

  res.writeHead(404);
  res.end("Not found");
});

const PORT = parseInt(process.env.PORT || "0", 10);
server.listen(PORT, "127.0.0.1", () => {
  const addr = server.address() as any;
  const url = `http://127.0.0.1:${addr.port}`;
  const marker = process.env.MOCK_MARKER_FILE;
  if (marker) {
    writeFileSync(marker, url, "utf-8");
  }
  console.log(`MOCK_OPENCODE_URL=${url}`);
});