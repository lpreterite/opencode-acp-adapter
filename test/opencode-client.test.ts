import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import {
  httpJson,
  createSession,
  sendPrompt,
  abortSession,
  sseSubscribe,
  startOpenCodeServer,
  getModelsFromCli,
} from "../src/opencode-client.js";

async function createTestServer(
  handler: (req: any, res: any) => void,
): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const addr = server.address() as any;
  return {
    url: `http://127.0.0.1:${addr.port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

function jsonResponse(res: any, data: any, status = 200) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(data));
}

describe("httpJson", () => {
  it("should send GET request and return response data", async () => {
    const server = await createTestServer((req, res) => {
      expect(req.method).toBe("GET");
      jsonResponse(res, { ok: true });
    });

    const result = await httpJson<{ ok: boolean }>(server.url);
    expect(result.ok).toBe(true);
    await server.close();
  });

  it("should send POST request with body", async () => {
    const server = await createTestServer((req, res) => {
      expect(req.method).toBe("POST");
      let body = "";
      req.on("data", (chunk: string) => (body += chunk));
      req.on("end", () => {
        const parsed = JSON.parse(body);
        expect(parsed.hello).toBe("world");
        jsonResponse(res, { received: true });
      });
    });

    const result = await httpJson<{ received: boolean }>(server.url, {
      method: "POST",
      body: JSON.stringify({ hello: "world" }),
    });
    expect(result.received).toBe(true);
    await server.close();
  });

  it("should throw on non-2xx response", async () => {
    const server = await createTestServer((req, res) => {
      jsonResponse(res, { error: "not found" }, 404);
    });

    await expect(httpJson(server.url)).rejects.toThrow("HTTP 404");
    await server.close();
  });

  it("should include content-type header by default", async () => {
    const server = await createTestServer((req, res) => {
      expect(req.headers["content-type"]).toBe("application/json");
      jsonResponse(res, {});
    });

    await httpJson(server.url, { method: "POST", body: "{}" });
    await server.close();
  });
});

describe("createSession", () => {
  it("should POST to /session and return session info", async () => {
    const server = await createTestServer((req, res) => {
      expect(req.method).toBe("POST");
      expect(req.url).toBe("/session");
      jsonResponse(res, { id: "sess-1" });
    });

    const result = await createSession(server.url);
    expect(result.id).toBe("sess-1");
    await server.close();
  });
});

describe("sendPrompt", () => {
  it("should POST to /session/:id/message with parts", async () => {
    const server = await createTestServer((req, res) => {
      expect(req.method).toBe("POST");
      expect(req.url).toBe("/session/sess-1/message");
      let body = "";
      req.on("data", (chunk: string) => (body += chunk));
      req.on("end", () => {
        const parsed = JSON.parse(body);
        expect(parsed.parts).toHaveLength(1);
        expect(parsed.parts[0].text).toBe("hello");
        jsonResponse(res, { info: { id: "msg-1" }, parts: [] });
      });
    });

    const result = await sendPrompt(server.url, "sess-1", {
      parts: [{ type: "text", text: "hello" }],
    });
    expect(result.info.id).toBe("msg-1");
    await server.close();
  });
});

describe("abortSession", () => {
  it("should POST to /session/:id/abort", async () => {
    const server = await createTestServer((req, res) => {
      expect(req.method).toBe("POST");
      expect(req.url).toBe("/session/sess-1/abort");
      jsonResponse(res, true);
    });

    const result = await abortSession(server.url, "sess-1");
    expect(result).toBe(true);
    await server.close();
  });
});

describe("sseSubscribe", () => {
  it("should receive and parse SSE events", async () => {
    const server = await createTestServer((req, res) => {
      expect(req.url).toBe("/event");
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      res.write(`data: ${JSON.stringify({ type: "test", properties: { value: 1 } })}\n\n`);
      res.write(`data: ${JSON.stringify({ type: "test", properties: { value: 2 } })}\n\n`);
      setTimeout(() => res.end(), 50);
    });

    const events: any[] = [];
    const sub = sseSubscribe(server.url, (evt) => events.push(evt));

    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(events).toHaveLength(2);
    expect(events[0].type).toBe("test");
    expect(events[1].properties.value).toBe(2);
    sub.close();
    await server.close();
  });

  it("should stop receiving events after close()", async () => {
    const server = await createTestServer((req, res) => {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      res.write(`data: ${JSON.stringify({ type: "test" })}\n\n`);
    });

    const events: any[] = [];
    const sub = sseSubscribe(server.url, (evt) => events.push(evt));

    await new Promise((resolve) => setTimeout(resolve, 100));
    sub.close();
    const countAfterClose = events.length;
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(events.length).toBe(countAfterClose);
    await server.close();
  });
});

describe("getModelsFromCli", () => {
  it("should throw when opencode binary fails", async () => {
    await expect(
      getModelsFromCli({ opencodeBin: "/nonexistent/bin" }),
    ).rejects.toThrow();
  });
});

describe("startOpenCodeServer", () => {
  const origUrl = process.env.OPENCODE_URL;

  afterEach(() => {
    if (origUrl) process.env.OPENCODE_URL = origUrl;
    else delete process.env.OPENCODE_URL;
  });

  it("should use OPENCODE_URL env var to skip binary startup", async () => {
    process.env.OPENCODE_URL = "http://localhost:9999";
    const server = await startOpenCodeServer({ cwd: "/test" });
    expect(server.url).toBe("http://localhost:9999");
    await server.stop();
  });
});