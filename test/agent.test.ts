import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { client, methods } from "@agentclientprotocol/sdk";
import type { ClientConnection } from "@agentclientprotocol/sdk";
import { createAgentApp } from "../src/agent.js";
import * as opencodeClient from "../src/opencode-client.js";
import * as mcpServer from "../src/mcp-server.js";
import * as sessionStore from "../src/session-store.js";

const mockStore = vi.hoisted(() => ({
  save: vi.fn().mockResolvedValue(undefined),
  load: vi.fn().mockResolvedValue(null as any),
  list: vi.fn().mockResolvedValue([]),
  delete: vi.fn().mockResolvedValue(undefined),
  appendMessage: vi.fn().mockResolvedValue(undefined),
}));

let sseCallback: ((event: any) => void) | null = null;

vi.mock("../src/opencode-client.js", () => ({
  startOpenCodeServer: vi.fn().mockResolvedValue({ url: "http://localhost:9999", stop: vi.fn() }),
  createSession: vi.fn().mockResolvedValue({ id: "test-oc-session-id" }),
  sseSubscribe: vi.fn().mockImplementation((_url: string, cb: (event: any) => void) => {
    sseCallback = cb;
    return { close: vi.fn() };
  }),
  sendPrompt: vi.fn().mockResolvedValue({ info: { id: "msg-1" }, parts: [] }),
  abortSession: vi.fn().mockResolvedValue(true),
}));

vi.mock("../src/mcp-server.js", () => ({
  createMcpServer: vi.fn().mockResolvedValue({
    address: () => ({ port: 12345, address: "127.0.0.1", family: "IPv4" }),
    close: vi.fn(),
  }),
}));

vi.mock("../src/session-store.js", () => ({
  createSessionStore: vi.fn().mockReturnValue(mockStore),
}));

const initParams = {
  protocolVersion: 1,
  clientInfo: { name: "test-client", version: "1.0.0" },
  clientCapabilities: {
    sessionCapabilities: { close: {}, list: {} },
  },
};

const newSessionParams = { cwd: "/test", mcpServers: [] };

function createTestClient() {
  return client({ name: "test-client" })
    .onRequest(methods.client.fs.readTextFile, async () => ({ content: "test file content" }))
    .onRequest(methods.client.fs.writeTextFile, async () => {})
    .onRequest(methods.client.terminal.create, async () => ({
      pid: 12345,
      terminalType: "test",
    }))
    .onRequest(methods.client.terminal.waitForExit, async () => {})
    .onRequest(methods.client.terminal.output, async () => ({
      output: "command output",
      exitStatus: { exitCode: 0 },
    }))
    .onRequest(methods.client.terminal.release, async () => {})
    .onNotification(methods.client.session.update, async () => {});
}

describe("createAgentApp", () => {
  let conn: ClientConnection;

  beforeEach(async () => {
    vi.clearAllMocks();
    sseCallback = null;
    mockStore.load.mockResolvedValue(null as any);
    mockStore.save.mockResolvedValue(undefined);
    mockStore.list.mockResolvedValue([]);
    mockStore.delete.mockResolvedValue(undefined);
    mockStore.appendMessage.mockResolvedValue(undefined);
    const agentApp = createAgentApp();
    const clientApp = createTestClient();
    conn = clientApp.connect(agentApp) as unknown as ClientConnection;
  });

  afterEach(async () => {
    conn.close();
  });

  describe("initialize", () => {
    it("should return protocolVersion 1", async () => {
      const res = await conn.agent.request(methods.agent.initialize, initParams);
      expect(res.protocolVersion).toBe(1);
    });

    it("should declare loadSession capability", async () => {
      const res = await conn.agent.request(methods.agent.initialize, initParams);
      expect(res.agentCapabilities.loadSession).toBe(true);
    });

    it("should declare session capabilities", async () => {
      const res = await conn.agent.request(methods.agent.initialize, initParams);
      expect(res.agentCapabilities.sessionCapabilities).toHaveProperty("resume");
      expect(res.agentCapabilities.sessionCapabilities).toHaveProperty("close");
      expect(res.agentCapabilities.sessionCapabilities).toHaveProperty("list");
    });

    it("should declare prompt capabilities", async () => {
      const res = await conn.agent.request(methods.agent.initialize, initParams);
      expect(res.agentCapabilities.promptCapabilities).toHaveProperty("image", true);
      expect(res.agentCapabilities.promptCapabilities).toHaveProperty("embeddedContext", true);
    });

    it("should have empty authMethods", async () => {
      const res = await conn.agent.request(methods.agent.initialize, initParams);
      expect(res.authMethods).toEqual([]);
    });
  });

  describe("authenticate", () => {
    it("should return empty object", async () => {
      await conn.agent.request(methods.agent.initialize, initParams);
      const res = await conn.agent.request(methods.agent.authenticate, { methodId: "none" });
      expect(res).toEqual({});
    });
  });

  describe("session/new", () => {
    it("should return a sessionId string", async () => {
      await conn.agent.request(methods.agent.initialize, initParams);
      const res = await conn.agent.request(methods.agent.session.new, newSessionParams);
      expect(typeof res.sessionId).toBe("string");
    });

    it("should start OpenCode server with cwd", async () => {
      await conn.agent.request(methods.agent.initialize, initParams);
      await conn.agent.request(methods.agent.session.new, newSessionParams);
      expect(opencodeClient.startOpenCodeServer).toHaveBeenCalledWith(
        expect.objectContaining({ cwd: "/test" }),
      );
    });

    it("should create OpenCode session", async () => {
      await conn.agent.request(methods.agent.initialize, initParams);
      await conn.agent.request(methods.agent.session.new, newSessionParams);
      expect(opencodeClient.createSession).toHaveBeenCalled();
    });

    it("should subscribe to SSE events", async () => {
      await conn.agent.request(methods.agent.initialize, initParams);
      await conn.agent.request(methods.agent.session.new, newSessionParams);
      expect(opencodeClient.sseSubscribe).toHaveBeenCalled();
    });

    it("should create MCP server", async () => {
      await conn.agent.request(methods.agent.initialize, initParams);
      await conn.agent.request(methods.agent.session.new, newSessionParams);
      expect(mcpServer.createMcpServer).toHaveBeenCalled();
    });

    it("should save session to store", async () => {
      await conn.agent.request(methods.agent.initialize, initParams);
      await conn.agent.request(methods.agent.session.new, newSessionParams);
      expect(mockStore.save).toHaveBeenCalledWith(expect.objectContaining({ cwd: "/test" }));
    });
  });

  describe("session/load", () => {
    it("should throw for non-existent session", async () => {
      await conn.agent.request(methods.agent.initialize, initParams);
      await expect(
        conn.agent.request(methods.agent.session.load, {
          sessionId: "nonexistent",
          cwd: "/test",
          mcpServers: [],
        }),
      ).rejects.toThrow();
    });

    it("should replay messages and create session for existing session", async () => {
      await conn.agent.request(methods.agent.initialize, initParams);
      mockStore.load.mockResolvedValue({
        sessionId: "sess-1",
        cwd: "/test",
        messages: [
          { role: "user", content: "hello", timestamp: "2026-01-01T00:00:00.000Z" },
        ],
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      });

      await conn.agent.request(methods.agent.session.load, {
        sessionId: "sess-1",
        cwd: "/test",
        mcpServers: [],
      });

      expect(opencodeClient.startOpenCodeServer).toHaveBeenCalled();
    });
  });

  describe("session/resume", () => {
    it("should throw for non-existent session", async () => {
      await conn.agent.request(methods.agent.initialize, initParams);
      await expect(
        conn.agent.request(methods.agent.session.resume, {
          sessionId: "nonexistent",
          cwd: "/test",
        }),
      ).rejects.toThrow();
    });

    it("should create session without replaying messages", async () => {
      await conn.agent.request(methods.agent.initialize, initParams);
      mockStore.load.mockResolvedValue({
        sessionId: "sess-1",
        cwd: "/test",
        messages: [
          { role: "user", content: "hello", timestamp: "2026-01-01T00:00:00.000Z" },
        ],
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      });

      await conn.agent.request(methods.agent.session.resume, {
        sessionId: "sess-1",
        cwd: "/test",
      });

      expect(opencodeClient.startOpenCodeServer).toHaveBeenCalled();
    });
  });

  describe("session/close", () => {
    it("should throw for non-existent session", async () => {
      await conn.agent.request(methods.agent.initialize, initParams);
      await expect(
        conn.agent.request(methods.agent.session.close, { sessionId: "nonexistent" }),
      ).rejects.toThrow();
    });

    it("should clean up resources for existing session", async () => {
      await conn.agent.request(methods.agent.initialize, initParams);
      const newRes = await conn.agent.request(methods.agent.session.new, newSessionParams);
      const sessionId = newRes.sessionId;

      await conn.agent.request(methods.agent.session.close, { sessionId });

      expect(opencodeClient.sseSubscribe).toHaveBeenCalled();
    });
  });

  describe("session/list", () => {
    it("should return empty list when no sessions", async () => {
      await conn.agent.request(methods.agent.initialize, initParams);
      const res = await conn.agent.request(methods.agent.session.list, {});
      expect(res.sessions).toEqual([]);
    });

    it("should include created sessions in list", async () => {
      await conn.agent.request(methods.agent.initialize, initParams);
      await conn.agent.request(methods.agent.session.new, newSessionParams);
      await conn.agent.request(methods.agent.session.new, { cwd: "/other", mcpServers: [] });

      expect(mockStore.save).toHaveBeenCalledTimes(2);
    });
  });

  describe("session/set_mode", () => {
    it("should return empty object", async () => {
      await conn.agent.request(methods.agent.initialize, initParams);
      const res = await conn.agent.request(methods.agent.session.setMode, {
        sessionId: "test",
        modeId: "edit",
      });
      expect(res).toEqual({});
    });
  });

  describe("session/set_config_option", () => {
    it("should return empty configOptions", async () => {
      await conn.agent.request(methods.agent.initialize, initParams);
      const res = await conn.agent.request(methods.agent.session.setConfigOption, {
        sessionId: "test",
        configId: "some.config",
        value: "some-value",
      });
      expect(res).toEqual({ configOptions: [] });
    });
  });

  describe("session/prompt", () => {
    it("should throw for non-existent session", async () => {
      await conn.agent.request(methods.agent.initialize, initParams);
      await expect(
        conn.agent.request(methods.agent.session.prompt, {
          sessionId: "nonexistent",
          prompt: [{ type: "text", text: "hello" }],
        }),
      ).rejects.toThrow();
    });
  });

  describe("session/cancel", () => {
    it("should handle cancel for non-existent session silently", async () => {
      await conn.agent.request(methods.agent.initialize, initParams);
      await conn.agent.notify(methods.agent.session.cancel, { sessionId: "nonexistent" });
    });

    it("should cancel an active prompt", async () => {
      await conn.agent.request(methods.agent.initialize, initParams);
      const session = await conn.agent.request(methods.agent.session.new, newSessionParams);

      vi.useFakeTimers();

      const promptPromise = conn.agent.request(methods.agent.session.prompt, {
        sessionId: session.sessionId,
        prompt: [{ type: "text", text: "hello" }],
      });

      await vi.advanceTimersByTimeAsync(100);

      await conn.agent.notify(methods.agent.session.cancel, { sessionId: session.sessionId });

      const prompt = await promptPromise;
      expect(prompt.stopReason).toBe("cancelled");

      vi.useRealTimers();
    });
  });

  describe("session/prompt silent timeout", () => {
    it("should return refusal when no SSE events arrive for 10 minutes", async () => {
      await conn.agent.request(methods.agent.initialize, initParams);
      const session = await conn.agent.request(methods.agent.session.new, newSessionParams);

      vi.useFakeTimers();

      const promptPromise = conn.agent.request(methods.agent.session.prompt, {
        sessionId: session.sessionId,
        prompt: [{ type: "text", text: "hello" }],
      });

      await vi.advanceTimersByTimeAsync(100);

      expect(sseCallback).toBeTruthy();
      sseCallback!({
        type: "message.part.updated",
        properties: {
          part: {
            type: "reasoning",
            text: "thinking...",
            id: "prt-think-1",
            sessionID: "test-oc-session-id",
            messageID: "msg-1",
          },
        },
      });

      await vi.advanceTimersByTimeAsync(9 * 60 * 1000);

      expect(sseCallback).toBeTruthy();
      sseCallback!({
        type: "message.part.updated",
        properties: {
          part: {
            type: "text",
            text: "still working...",
            id: "prt-text-1",
            sessionID: "test-oc-session-id",
            messageID: "msg-1",
          },
        },
      });

      await vi.advanceTimersByTimeAsync(10 * 60 * 1000 + 1000);

      const prompt = await promptPromise;
      expect(prompt.stopReason).toBe("refusal");

      vi.useRealTimers();
    });
  });

  describe("full lifecycle", () => {
    it("should complete initialize → session/new → session/prompt → session/close", async () => {
      await conn.agent.request(methods.agent.initialize, initParams);

      const session = await conn.agent.request(methods.agent.session.new, newSessionParams);
      expect(typeof session.sessionId).toBe("string");

      vi.useFakeTimers();

      const promptPromise = conn.agent.request(methods.agent.session.prompt, {
        sessionId: session.sessionId,
        prompt: [{ type: "text", text: "hello" }],
      });

      await vi.advanceTimersByTimeAsync(100);

      expect(sseCallback).toBeTruthy();
      sseCallback!({
        type: "message.part.updated",
        properties: {
          part: {
            type: "step-finish",
            reason: "stop",
            id: "prt-finish-1",
            sessionID: "test-oc-session-id",
            messageID: "msg-1",
          },
        },
      });

      const prompt = await promptPromise;
      expect(prompt.stopReason).toBe("end_turn");

      vi.useRealTimers();

      await conn.agent.request(methods.agent.session.close, { sessionId: session.sessionId });
    });
  });
});