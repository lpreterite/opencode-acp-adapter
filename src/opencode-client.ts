import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { once } from "node:events";

export type OpenCodeServer = {
  url: string;
  process?: ChildProcessWithoutNullStreams;
  stop: () => Promise<void>;
};

function parseListeningUrl(line: string): string | null {
  const m = line.match(/opencode server listening on (https?:\/\/[^\s]+)/i);
  return m ? m[1] : null;
}

export async function startOpenCodeServer(opts: {
  cwd: string;
  opencodeBin?: string;
  configContent?: any;
  hostname?: string;
  port?: number;
}): Promise<OpenCodeServer> {
  if (process.env.OPENCODE_URL) {
    return { url: process.env.OPENCODE_URL, stop: async () => {} };
  }

  const bin = opts.opencodeBin || process.env.OPENCODE_BIN || "opencode";

  try {
    accessSync(bin, constants.X_OK);
  } catch {
    throw new Error(
      `OpenCode binary not found: "${bin}". ` +
      `Ensure opencode is installed and available in PATH, or set OPENCODE_BIN env var to specify the path. ` +
      `See https://opencode.ai for installation instructions.`,
    );
  }

  const args = ["serve", "--hostname", opts.hostname || "127.0.0.1", "--port", String(opts.port ?? 0)];

  const env = {
    ...process.env,
    ...(opts.configContent
      ? { OPENCODE_CONFIG_CONTENT: JSON.stringify(opts.configContent), OPENCODE: "1" }
      : { OPENCODE: "1" }),
  };

  const child = spawn(bin, args, {
    cwd: opts.cwd,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });

  child.on("error", (error) => {
    console.error("Failed to start opencode server:", error);
  });

  child.on("exit", (code, signal) => {
    if (code !== 0) {
      console.error(`opencode server exited with code ${code}, signal ${signal}`);
    }
  });

  let url: string | undefined;
  let stdoutData = "";
  let stderrData = "";

  child.stdout.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf8");
    stdoutData += text;
    console.error("opencode stdout:", text);
    const maybeUrl = parseListeningUrl(text);
    if (maybeUrl) url = maybeUrl;
  });

  child.stderr.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf8");
    stderrData += text;
    console.error("opencode stderr:", text);
    const maybeUrl = parseListeningUrl(text);
    if (maybeUrl) url = maybeUrl;
  });

  const start = Date.now();
  while (!url && Date.now() - start < 5000) {
    await new Promise((r) => setTimeout(r, 50));
  }
  if (!url) {
    child.kill();
    throw new Error(
      `Failed to start opencode server (URL not detected). stdout: ${stdoutData.slice(0, 500)}, stderr: ${stderrData.slice(0, 500)}`,
    );
  }

  return {
    url,
    process: child,
    stop: async () => {
      try {
        child.kill();
        await once(child, "exit");
      } catch {}
    },
  };
}

export async function httpJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers || {}) },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status}: ${text}`);
  }
  return (await res.json()) as T;
}

export type OpenCodeEvent = {
  type: string;
  properties: any;
};

export type OpenCodeSessionInfo = { id: string } & Record<string, any>;

export async function createSession(baseUrl: string): Promise<OpenCodeSessionInfo> {
  return httpJson(`${baseUrl}/session`, { method: "POST", body: JSON.stringify({}) });
}

export type PromptPart =
  | { type: "text"; text: string; id?: string }
  | { type: "file"; url: string; filename?: string; mime: string; id?: string }
  | { type: "agent"; name: string; id?: string };

export async function sendPrompt(
  baseUrl: string,
  sessionId: string,
  body: {
    parts: PromptPart[];
    agent?: string;
    model?: { providerID: string; modelID: string };
  },
): Promise<{ info: { id: string }; parts: any[] }> {
  return httpJson(`${baseUrl}/session/${sessionId}/message`, {
    method: "POST",
    body: JSON.stringify({ parts: body.parts, agent: body.agent, model: body.model }),
  });
}

export type ModelInfo = {
  providerID: string;
  modelID: string;
  name: string;
};

export async function getModels(baseUrl: string): Promise<{ models: ModelInfo[]; defaultModel: string }> {
  const config = await httpJson<any>(`${baseUrl}/config/providers`);
  const models: ModelInfo[] = [];
  for (const provider of config.providers || []) {
    for (const m of Object.values(provider.models || {}) as any[]) {
      models.push({
        providerID: provider.id,
        modelID: m.id,
        name: m.name || m.id,
      });
    }
  }
  const defaultModel = models.length > 0 ? `${models[0].providerID}/${models[0].modelID}` : "";
  return { models, defaultModel };
}

export async function getModelsFromCli(opts?: {
  opencodeBin?: string;
}): Promise<{ models: ModelInfo[]; defaultModel: string }> {
  const bin = opts?.opencodeBin || process.env.OPENCODE_BIN || "opencode";
  const args = ["models", "--verbose"];

  const child = spawn(bin, args, {
    env: { ...process.env, OPENCODE: "1" },
    stdio: ["pipe", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
  child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });

  const code = await new Promise<number | null>((resolve) => {
    child.on("close", resolve);
    child.on("error", () => resolve(null));
  });

  if (code !== 0 || !stdout) {
    throw new Error(`opencode models failed (exit=${code}): ${stderr.slice(0, 200)}`);
  }

  const models: ModelInfo[] = [];
  const lines = stdout.split("\n");
  let braceCount = 0;
  let jsonLines: string[] = [];
  let inJson = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!inJson && trimmed.startsWith("{")) {
      inJson = true;
      jsonLines = [line];
      braceCount = 1;
      continue;
    }
    if (inJson) {
      jsonLines.push(line);
      for (const ch of line) {
        if (ch === "{") braceCount++;
        if (ch === "}") braceCount--;
      }
      if (braceCount === 0) {
        inJson = false;
        try {
          const obj = JSON.parse(jsonLines.join("\n"));
          if (obj.providerID && obj.id) {
            models.push({
              providerID: obj.providerID,
              modelID: obj.id,
              name: obj.name || obj.id,
            });
          }
        } catch {}
      }
    }
  }

  const defaultModel = models.length > 0 ? `${models[0].providerID}/${models[0].modelID}` : "";
  return { models, defaultModel };
}

export async function abortSession(baseUrl: string, sessionId: string): Promise<boolean> {
  return httpJson(`${baseUrl}/session/${sessionId}/abort`, { method: "POST" });
}

export function sseSubscribe(
  baseUrl: string,
  onEvent: (event: OpenCodeEvent) => void,
) {
  const controller = new AbortController();
  const signal = controller.signal;
  (async () => {
    try {
      const res = await fetch(`${baseUrl}/event`, { signal, headers: { accept: "text/event-stream" } });
      if (!res.ok || !res.body) throw new Error(`SSE error: ${res.status}`);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buffer.indexOf("\n\n")) !== -1) {
          const raw = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          for (const line of raw.split("\n")) {
            if (line.startsWith("data: ")) {
              const json = line.slice(6);
              try {
                const evt = JSON.parse(json) as OpenCodeEvent;
                onEvent(evt);
              } catch {}
            }
          }
        }
      }
    } catch (e) {
      // swallow; caller controls lifecycle
    }
  })();
  return { close: () => controller.abort() };
}