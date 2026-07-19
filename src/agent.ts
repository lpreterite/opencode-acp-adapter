import { agent, methods } from "@agentclientprotocol/sdk";
import type { AgentContext, Stream } from "@agentclientprotocol/sdk";
import type { AgentApp } from "@agentclientprotocol/sdk";
import type { StopReason } from "@agentclientprotocol/sdk";
import { v7 as uuidv7 } from "uuid";
import { AddressInfo } from "node:net";
import { type Server } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { createMcpServer } from "./mcp-server.js";
import {
  abortSession,
  createSession,
  getModels,
  sseSubscribe,
  startOpenCodeServer,
  sendPrompt,
  type ModelInfo,
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
  pendingPrompt: { resolve: (result: { stopReason: StopReason }) => void; reject: (err: any) => void } | null;
  lastEventAt: number;
  selectedModel?: { providerID: string; modelID: string };
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

      session.lastEventAt = Date.now();

      if (part.type === "step-finish" && part.reason === "stop") {
        session.activeMessageId = undefined;
        const pp = session.pendingPrompt;
        session.pendingPrompt = null;
        if (pp) pp.resolve({ stopReason: "end_turn" });
        return;
      }

      const notifications = partToAcpNotifications(part, acpSessionId, session.partSeen);
      for (const n of notifications) {
        session.client.notify(methods.client.session.update, n);
      }
    }
  } catch (e) {
    console.error("event handling error", e);
  }
}

export function createMcpBridge(client: AgentContext) {
  return {
    readTextFile: async (params: { sessionId: string; path: string; line?: number; limit?: number }) => {
      try {
        return await client.request(methods.client.fs.readTextFile, params) as { content: string };
      } catch {
        const content = await readFile(params.path, "utf-8");
        if (params.line !== undefined || params.limit !== undefined) {
          const lines = content.split("\n");
          const start = params.line || 0;
          const end = params.limit ? start + params.limit : undefined;
          return { content: lines.slice(start, end).join("\n") };
        }
        return { content };
      }
    },
    writeTextFile: async (params: { sessionId: string; path: string; content: string }) => {
      try {
        await client.request(methods.client.fs.writeTextFile, params);
      } catch {
        await writeFile(params.path, params.content, "utf-8");
      }
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

let cachedModels: ModelInfo[] | null = null;
let cachedDefaultModel = "";

async function ensureModels(baseUrl: string): Promise<{ models: ModelInfo[]; defaultModel: string }> {
  if (cachedModels) return { models: cachedModels, defaultModel: cachedDefaultModel };
  const result = await getModels(baseUrl);
  cachedModels = result.models;
  cachedDefaultModel = result.defaultModel;
  return result;
}

async function createOcSession(
  acpSessionId: string,
  client: AgentContext,
  cwd: string,
  sessions: Map<string, AcpSession>,
  mcpServers?: any[],
) {
  const mcpServer = await createMcpServer(createMcpBridge(client), acpSessionId, undefined, mcpServers);
  const mcpAddress = mcpServer.address() as AddressInfo;
  const mcpUrl = `http://127.0.0.1:${mcpAddress.port}/mcp`;

  const ocServer = await startOpenCodeServer({
    cwd,
    configContent: {
      tools: { read: true, write: true, edit: true, multiedit: true, bash: true, patch: true },
      mcp: { acp: { type: "remote", url: mcpUrl } },
    },
  });

  const ocSession = await createSession(ocServer.url);
  const sub = sseSubscribe(ocServer.url, (evt) => handleOpenCodeEvent(sessions, acpSessionId, evt));

  const { defaultModel } = await ensureModels(ocServer.url);

  sessions.set(acpSessionId, {
    id: acpSessionId,
    oc: { server: ocServer, sessionId: ocSession.id },
    cancelled: false,
    partSeen: {},
    mcpServer,
    client,
    subscription: sub,
    pendingPrompt: null,
    lastEventAt: 0,
    selectedModel: defaultModel ? parseModelRef(defaultModel) : undefined,
  });
}

function parseModelRef(ref: string): { providerID: string; modelID: string } {
  const parts = ref.split("/");
  return { providerID: parts[0], modelID: parts.slice(1).join("/") };
}

function buildConfigOptions() {
  if (!cachedModels || cachedModels.length === 0) return [];
  return [{
    id: "model",
    name: "Model",
    category: "model" as const,
    type: "select" as const,
    currentValue: cachedDefaultModel,
    options: cachedModels.map((m) => ({
      value: `${m.providerID}/${m.modelID}`,
      name: m.name,
    })),
  }];
}

export function createAgentApp(): AgentApp {
  const sessions = new Map<string, AcpSession>();
  const sessionStore = createSessionStore();

  const app = agent({ name: "opencode-acp" });

  app.onRequest(methods.agent.initialize, async () => {
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
  });

  app.onRequest(methods.agent.authenticate, async () => {
    return {};
  });

  app.onRequest(methods.agent.session.new, async (ctx) => {
    const { cwd, mcpServers } = ctx.params;
    const acpSessionId = uuidv7();

    await createOcSession(acpSessionId, ctx.client, cwd || process.cwd(), sessions, mcpServers);

    await sessionStore.save({
      sessionId: acpSessionId,
      cwd: cwd || process.cwd(),
      messages: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    return { sessionId: acpSessionId, configOptions: buildConfigOptions() };
  });

  app.onRequest(methods.agent.session.load, async (ctx) => {
    const { sessionId, cwd, mcpServers } = ctx.params;
    const record = await sessionStore.load(sessionId);
    if (!record) throw new Error(`Session ${sessionId} not found`);

    for (const msg of record.messages) {
      const updateType = msg.role === "user" ? "user_message_chunk" : "agent_message_chunk";
      await ctx.client.notify(methods.client.session.update, {
        sessionId,
        update: { sessionUpdate: updateType, content: { type: "text", text: msg.content } },
      });
    }

    await createOcSession(sessionId, ctx.client, cwd || record.cwd, sessions, mcpServers);

    return { configOptions: buildConfigOptions() };
  });

  app.onRequest(methods.agent.session.resume, async (ctx) => {
    const { sessionId, cwd, mcpServers } = ctx.params;
    const record = await sessionStore.load(sessionId);
    if (!record) throw new Error(`Session ${sessionId} not found`);

    await createOcSession(sessionId, ctx.client, cwd || record.cwd, sessions, mcpServers);

    return { configOptions: buildConfigOptions() };
  });

  app.onRequest(methods.agent.session.close, async (ctx) => {
    const { sessionId } = ctx.params;
    const session = sessions.get(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);

    session.subscription.close();
    await session.oc.server.stop();
    session.mcpServer.close();
    sessions.delete(sessionId);

    return {};
  });

  app.onRequest(methods.agent.session.list, async () => {
    const records = await sessionStore.list();
    return {
      sessions: records.map((r) => ({
        sessionId: r.sessionId,
        cwd: r.cwd,
        createdAt: r.createdAt,
        messageCount: r.messages.length,
      })),
    };
  });

  app.onRequest(methods.agent.session.setMode, async () => {
    return {};
  });

  app.onRequest(methods.agent.session.setConfigOption, async (ctx) => {
    const { sessionId, configId, value } = ctx.params;
    if (configId === "model" && typeof value === "string") {
      const session = sessions.get(sessionId);
      if (session) {
        session.selectedModel = parseModelRef(value);
      }
    }
    return { configOptions: buildConfigOptions() };
  });

  app.onRequest(methods.agent.session.prompt, async (ctx) => {
    const session = sessions.get(ctx.params.sessionId);
    if (!session) throw new Error("Session not found");
    session.cancelled = false;

    const parts = promptToOpenCodeParts(ctx.params.prompt);

    const model = session.selectedModel;

    const result = await new Promise<{ stopReason: StopReason }>((resolve, reject) => {
      session.pendingPrompt = { resolve, reject };
      session.lastEventAt = Date.now();

      sendPrompt(session.oc.server.url, session.oc.sessionId, { parts, model }).then((res) => {
        session.activeMessageId = res.info.id;
      }).catch((err) => {
        const pp = session.pendingPrompt;
        session.pendingPrompt = null;
        if (pp) pp.reject(err);
      });

      const SILENT_TIMEOUT = 10 * 60 * 1000;
      (async () => {
        while (session.pendingPrompt) {
          await new Promise((r) => setTimeout(r, 1000));
          if (session.cancelled) {
            const pp = session.pendingPrompt;
            session.pendingPrompt = null;
            if (pp) pp.resolve({ stopReason: "cancelled" });
            return;
          }
          if (Date.now() - session.lastEventAt > SILENT_TIMEOUT) {
            const pp = session.pendingPrompt;
            session.pendingPrompt = null;
            if (pp) pp.resolve({ stopReason: "refusal" });
            return;
          }
        }
      })();
    });

    return result;
  });

  app.onNotification(methods.agent.session.cancel, async (ctx) => {
    const session = sessions.get(ctx.params.sessionId);
    if (!session) return;
    session.cancelled = true;
    const pp = session.pendingPrompt;
    session.pendingPrompt = null;
    if (pp) pp.resolve({ stopReason: "cancelled" });
    try {
      await abortSession(session.oc.server.url, session.oc.sessionId);
    } catch {}
  });

  return app;
}

export async function runAgent(stream: Stream) {
  createAgentApp().connect(stream);
}