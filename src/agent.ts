import { agent, methods } from "@agentclientprotocol/sdk";
import type { AgentContext, Stream } from "@agentclientprotocol/sdk";
import { v7 as uuidv7 } from "uuid";
import { AddressInfo } from "node:net";
import { type Server } from "node:http";
import { createMcpServer } from "./mcp-server.js";
import {
  abortSession,
  createSession,
  sseSubscribe,
  startOpenCodeServer,
  sendPrompt,
  type OpenCodeEvent,
  type OpenCodeServer,
  type PromptPart,
} from "./opencode-client.js";
import { createSessionStore } from "./session-store.js";

type McpTerminalHandle = {
  waitForExit: () => Promise<void>;
  currentOutput: () => Promise<{ output: string; exitStatus?: { exitCode: number } }>;
  release: () => Promise<void>;
};

type AcpSession = {
  id: string;
  oc: {
    server: OpenCodeServer;
    sessionId: string;
  };
  cancelled: boolean;
  activeMessageId?: string;
  partSeen: Record<string, number>;
  mcpServer: Server;
  client: AgentContext;
  subscription: { close: () => void };
};

export function promptToOpenCodeParts(prompt: any[]): PromptPart[] {
  const parts: PromptPart[] = [];
  for (const chunk of prompt) {
    switch (chunk.type) {
      case "text":
        parts.push({ type: "text", text: chunk.text });
        break;
      case "resource_link":
        parts.push({ type: "text", text: chunk.uri });
        break;
      case "resource":
        if ("text" in chunk.resource) {
          parts.push({ type: "text", text: chunk.resource.text });
        }
        break;
      case "image": {
        if (chunk.data && chunk.mimeType) {
          parts.push({ type: "file", url: `data:${chunk.mimeType};base64,${chunk.data}`, mime: chunk.mimeType });
        } else if (chunk.uri) {
          parts.push({ type: "file", url: chunk.uri, mime: chunk.mimeType || "application/octet-stream" });
        }
        break;
      }
    }
  }
  return parts;
}

export function partToAcpNotifications(
  part: any,
  acpSessionId: string,
  partSeen: Record<string, number>,
): any[] {
  const out: any[] = [];
  if (part.type === "text") {
    const prev = partSeen[part.id] || 0;
    const text: string = part.text || "";
    const chunk = text.slice(prev);
    partSeen[part.id] = text.length;
    if (chunk.length > 0) {
      out.push({
        sessionId: acpSessionId,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: chunk } },
      });
    }
  }
  if (part.type === "reasoning") {
    const prev = partSeen[part.id] || 0;
    const text: string = part.text || "";
    const chunk = text.slice(prev);
    partSeen[part.id] = text.length;
    if (chunk.length > 0) {
      out.push({
        sessionId: acpSessionId,
        update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: chunk } },
      });
    }
  }
  if (part.type === "tool") {
    const state = part.state?.status;
    const toolCallId = part.callID || part.id;
    if (state === "running") {
      out.push({
        sessionId: acpSessionId,
        update: {
          sessionUpdate: "tool_call",
          toolCallId,
          status: "pending",
          title: part.tool,
          rawInput: part.state?.input,
          kind: "other",
          content: [],
          locations: [],
        },
      });
    }
    if (state === "completed" || state === "error") {
      out.push({
        sessionId: acpSessionId,
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId,
          status: state === "completed" ? "completed" : "failed",
          content: part.state?.output
            ? [{ type: "content", content: { type: "text", text: part.state.output } }]
            : [],
          locations: [],
        },
      });
    }
  }
  return out;
}

function handleOpenCodeEvent(
  sessions: Map<string, AcpSession>,
  acpSessionId: string,
  event: OpenCodeEvent,
) {
  const session = sessions.get(acpSessionId);
  if (!session) return;
  try {
    if (event.type === "message.part.updated") {
      const part = event.properties.part;
      if (!part || part.sessionID !== session.oc.sessionId) return;
      if (session.activeMessageId && part.messageID !== session.activeMessageId) return;

      const notifications = partToAcpNotifications(part, acpSessionId, session.partSeen);
      for (const n of notifications) {
        session.client.notify(methods.client.session.update, n);
      }
    }
  } catch (e) {
    console.error("event handling error", e);
  }
}

function createMcpBridge(client: AgentContext) {
  return {
    readTextFile: async (params: { sessionId: string; path: string; line?: number; limit?: number }) => {
      return client.request(methods.client.fs.readTextFile, params) as Promise<{ content: string }>;
    },
    writeTextFile: async (params: { sessionId: string; path: string; content: string }) => {
      await client.request(methods.client.fs.writeTextFile, params);
    },
    createTerminal: async (params: { command: string; sessionId: string; outputByteLimit?: number }): Promise<McpTerminalHandle> => {
      const handle = await client.request(methods.client.terminal.create, params) as any;
      return {
        waitForExit: () => client.request(methods.client.terminal.waitForExit, { sessionId: params.sessionId }),
        currentOutput: () => client.request(methods.client.terminal.output, { sessionId: params.sessionId }) as Promise<any>,
        release: () => client.request(methods.client.terminal.release, { sessionId: params.sessionId }),
      };
    },
  };
}

async function createOcSession(
  acpSessionId: string,
  client: AgentContext,
  cwd: string,
  sessions: Map<string, AcpSession>,
) {
  const mcpServer = await createMcpServer(createMcpBridge(client), acpSessionId, undefined);
  const mcpAddress = mcpServer.address() as AddressInfo;
  const mcpUrl = `http://127.0.0.1:${mcpAddress.port}/mcp`;

  const ocServer = await startOpenCodeServer({
    cwd,
    configContent: {
      tools: { read: false, write: false, edit: false, multiedit: false, bash: false, patch: false },
      mcp: { acp: { type: "remote", url: mcpUrl } },
    },
  });

  const ocSession = await createSession(ocServer.url);
  const sub = sseSubscribe(ocServer.url, (evt) => handleOpenCodeEvent(sessions, acpSessionId, evt));

  sessions.set(acpSessionId, {
    id: acpSessionId,
    oc: { server: ocServer, sessionId: ocSession.id },
    cancelled: false,
    partSeen: {},
    mcpServer,
    client,
    subscription: sub,
  });
}

export async function runAgent(stream: Stream) {
  const sessions = new Map<string, AcpSession>();
  const sessionStore = createSessionStore();

  agent({ name: "opencode-acp" })
    .onRequest(methods.agent.initialize, async () => {
      return {
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: true,
          sessionCapabilities: {
            resume: {},
            close: {},
            list: {},
          },
          promptCapabilities: { image: true, embeddedContext: true },
        },
        authMethods: [],
      };
    })

    .onRequest(methods.agent.authenticate, async () => {
      return {};
    })

    .onRequest(methods.agent.session.new, async (ctx) => {
      const { cwd } = ctx.params;
      const acpSessionId = uuidv7();

      await createOcSession(acpSessionId, ctx.client, cwd || process.cwd(), sessions);

      await sessionStore.save({
        sessionId: acpSessionId,
        cwd: cwd || process.cwd(),
        messages: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      return { sessionId: acpSessionId };
    })

    .onRequest(methods.agent.session.load, async (ctx) => {
      const { sessionId, cwd } = ctx.params;
      const record = await sessionStore.load(sessionId);
      if (!record) throw new Error(`Session ${sessionId} not found`);

      for (const msg of record.messages) {
        const updateType = msg.role === "user" ? "user_message_chunk" : "agent_message_chunk";
        await ctx.client.notify(methods.client.session.update, {
          sessionId,
          update: { sessionUpdate: updateType, content: { type: "text", text: msg.content } },
        });
      }

      await createOcSession(sessionId, ctx.client, cwd || record.cwd, sessions);

      return {};
    })

    .onRequest(methods.agent.session.resume, async (ctx) => {
      const { sessionId, cwd } = ctx.params;
      const record = await sessionStore.load(sessionId);
      if (!record) throw new Error(`Session ${sessionId} not found`);

      await createOcSession(sessionId, ctx.client, cwd || record.cwd, sessions);

      return {};
    })

    .onRequest(methods.agent.session.close, async (ctx) => {
      const { sessionId } = ctx.params;
      const session = sessions.get(sessionId);
      if (!session) throw new Error(`Session ${sessionId} not found`);

      session.subscription.close();
      await session.oc.server.stop();
      session.mcpServer.close();
      sessions.delete(sessionId);

      return {};
    })

    .onRequest(methods.agent.session.list, async () => {
      const records = await sessionStore.list();
      return {
        sessions: records.map((r) => ({
          sessionId: r.sessionId,
          cwd: r.cwd,
          createdAt: r.createdAt,
          messageCount: r.messages.length,
        })),
      };
    })

    .onRequest(methods.agent.session.setMode, async () => {
      return {};
    })

    .onRequest(methods.agent.session.setConfigOption, async () => {
      return { configOptions: [] };
    })

    .onRequest(methods.agent.session.prompt, async (ctx) => {
      const session = sessions.get(ctx.params.sessionId);
      if (!session) throw new Error("Session not found");
      session.cancelled = false;

      const parts = promptToOpenCodeParts(ctx.params.prompt);
      const res = await sendPrompt(session.oc.server.url, session.oc.sessionId, { parts });
      session.activeMessageId = res.info.id;

      const start = Date.now();
      while (true) {
        if (session.cancelled) return { stopReason: "cancelled" };
        try {
          const info = await fetch(
            `${session.oc.server.url}/session/${session.oc.sessionId}/message/${session.activeMessageId}`,
          ).then((r) => r.json());
          if (info?.time?.completed) {
            session.activeMessageId = undefined;
            return { stopReason: "end_turn" };
          }
        } catch {}
        await new Promise((r) => setTimeout(r, 150));
        if (Date.now() - start > 10 * 60 * 1000) return { stopReason: "refusal" };
      }
    })

    .onNotification(methods.agent.session.cancel, async (ctx) => {
      const session = sessions.get(ctx.params.sessionId);
      if (!session) return;
      session.cancelled = true;
      try {
        await abortSession(session.oc.server.url, session.oc.sessionId);
      } catch {}
    })

    .connect(stream);
}