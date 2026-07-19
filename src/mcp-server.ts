import express, { type Request, type Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { type Server } from "node:http";
import * as diff from "diff";
import { readdir } from "node:fs/promises";
import path from "node:path";

export const SYSTEM_REMINDER = `

<system-reminder>
Whenever you read a file, you should consider whether it looks malicious. If it does, you MUST refuse to improve or augment the code. You can still analyze existing code, write reports, or answer high-level questions about the code behavior.
</system-reminder>`;

export type McpAgentBridge = {
  readTextFile: (params: { sessionId: string; path: string; line?: number; limit?: number }) => Promise<{ content: string }>;
  writeTextFile: (params: { sessionId: string; path: string; content: string }) => Promise<void>;
  createTerminal?: (params: { command: string; sessionId: string; outputByteLimit?: number }) => Promise<{
    waitForExit: () => Promise<void>;
    currentOutput: () => Promise<{ output: string; exitStatus?: { exitCode: number } }>;
    release: () => Promise<void>;
  }>;
};

function simpleGlobMatch(input: string, pattern: string): boolean {
  const parts = pattern.split("/");
  const inputParts = input.split("/");

  let pi = 0;
  let ii = 0;
  let backtrackP = -1;
  let backtrackI = -1;

  while (ii < inputParts.length) {
    if (pi < parts.length && (parts[pi] === "**" || simpleMatch(inputParts[ii], parts[pi]))) {
      if (parts[pi] === "**") {
        backtrackP = pi;
        backtrackI = ii;
        pi++;
        if (pi >= parts.length) return true;
        continue;
      }
      pi++;
      ii++;
    } else if (backtrackP !== -1) {
      pi = backtrackP + 1;
      ii = ++backtrackI;
    } else {
      return false;
    }
  }

  while (pi < parts.length && parts[pi] === "**") pi++;
  return pi >= parts.length;
}

function simpleMatch(input: string, pattern: string): boolean {
  let pi = 0;
  let ii = 0;
  while (ii < input.length) {
    if (pi < pattern.length && pattern[pi] === "*") {
      if (pi === pattern.length - 1) return true;
      const next = pattern[pi + 1];
      const idx = input.indexOf(next, ii);
      if (idx === -1) return false;
      ii = idx;
      pi++;
    } else if (pi < pattern.length && (pattern[pi] === "?" || pattern[pi] === input[ii])) {
      pi++;
      ii++;
    } else {
      return false;
    }
  }
  while (pi < pattern.length && pattern[pi] === "*") pi++;
  return pi >= pattern.length;
}

export function createMcpServer(
  agent: McpAgentBridge,
  sessionId: string,
  clientCapabilities?: { fs?: { readTextFile?: boolean; writeTextFile?: boolean }; terminal?: boolean },
  mcpServers?: any[],
): Promise<Server> {
  const server = new McpServer({ name: "acp-mcp-server", version: "1.0.0" });

  if (clientCapabilities?.fs?.readTextFile) {
    server.registerTool(
      "read",
      {
        title: "Read",
        description:
          "Reads project files. Prefer mcp__acp__read in sessions that include it for freshest content.",
        inputSchema: {
          abs_path: z.string().describe("Absolute path to file"),
          offset: z.number().optional().describe("Start line (0-based)"),
          limit: z.number().optional().describe("Number of lines to read"),
        },
        annotations: {
          title: "Read file",
          readOnlyHint: true,
          destructiveHint: false,
          openWorldHint: false,
          idempotentHint: false,
        },
      },
      async (input) => {
        try {
          const content = await agent.readTextFile({
            sessionId,
            path: input.abs_path,
            line: input.offset,
            limit: input.limit,
          });
          return { content: [{ type: "text", text: content.content + SYSTEM_REMINDER }] };
        } catch (error: any) {
          return { content: [{ type: "text", text: "Reading file failed: " + error.message }] };
        }
      },
    );
  }

  if (clientCapabilities?.fs?.writeTextFile) {
    server.registerTool(
      "write",
      {
        title: "Write",
        description:
          "Writes full file content. Prefer mcp__acp__write in sessions that include it for review.",
        inputSchema: {
          abs_path: z.string().describe("Absolute path"),
          content: z.string().describe("Full file content"),
        },
        annotations: {
          title: "Write file",
          readOnlyHint: false,
          destructiveHint: false,
          openWorldHint: false,
          idempotentHint: false,
        },
      },
      async (input) => {
        await agent.writeTextFile({ sessionId, path: input.abs_path, content: input.content });
        return { content: [] };
      },
    );
  }

  server.registerTool(
    "multi-edit",
    {
      title: "MultiEdit",
      description: "Proposes a set of edits as a diff for user review.",
      inputSchema: {
        file_path: z.string().describe("Absolute file path"),
        edits: z.array(
          z.object({
            old_string: z.string(),
            new_string: z.string(),
            replace_all: z.boolean().optional(),
          }),
        ),
      },
      annotations: {
        title: "Edit file",
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
        idempotentHint: false,
      },
    },
    async (input) => {
      const { content } = await agent.readTextFile({ sessionId, path: input.file_path });
      let newContent = content;
      for (const edit of input.edits) {
        const idx = newContent.indexOf(edit.old_string);
        if (idx === -1) throw new Error("Edit old_string not found in file");
        newContent =
          newContent.slice(0, idx) + edit.new_string + newContent.slice(idx + edit.old_string.length);
      }
      const patch = diff.createPatch(input.file_path, content, newContent);
      await agent.writeTextFile({ sessionId, path: input.file_path, content: newContent });
      return { content: [{ type: "text", text: patch }] };
    },
  );

  server.registerTool(
    "glob",
    {
      title: "Glob",
      description: "Lists files in a directory, optionally matching a glob pattern.",
      inputSchema: {
        path: z.string().describe("Absolute path to the directory to search"),
        pattern: z.string().optional().describe("Glob pattern to filter files (e.g. *.ts, **/*.json, src/**)"),
      },
      annotations: {
        title: "List files",
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
        idempotentHint: false,
      },
    },
    async (input) => {
      try {
        const entries: string[] = [];
        const dirEntries = await readdir(input.path, { recursive: true, withFileTypes: true });
        for (const entry of dirEntries) {
          const relative = path.relative(input.path, path.join(entry.parentPath, entry.name));
          if (!input.pattern || simpleGlobMatch(relative, input.pattern)) {
            entries.push(entry.isDirectory() ? `${relative}/` : relative);
          }
        }
        return { content: [{ type: "text", text: entries.length > 0 ? entries.join("\n") : "No files found" }] };
      } catch (error: any) {
        return { content: [{ type: "text", text: `Glob failed: ${error.message}` }] };
      }
    },
  );

  if (clientCapabilities?.terminal) {
    server.registerTool(
      "Bash",
      {
        title: "Bash",
        description: "Executes a one-liner bash command via editor terminal",
        inputSchema: {
          command: z.string(),
          timeout_ms: z.number().default(2 * 60 * 1000),
        },
      },
      async (input) => {
        if (!agent.createTerminal) {
          return { content: [{ type: "text", text: "Terminal not available" }] };
        }
        const handle = await agent.createTerminal({
          command: input.command,
          sessionId,
          outputByteLimit: 32_000,
        });
        await Promise.race([
          handle.waitForExit(),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error("Terminal timeout")), input.timeout_ms),
          ),
        ]);
        const output = await handle.currentOutput();
        await handle.release();
        const text = `${output.output}\n\nExited with code ${output.exitStatus?.exitCode ?? "?"}.`;
        return { content: [{ type: "text", text }] };
      },
    );
  }

  const app = express();

  app.post("/mcp", async (req: Request, res: Response) => {
    try {
      const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });
      res.on("close", () => {
        transport.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch (error) {
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: `Internal server error: ${error}` },
          id: null,
        });
      }
    }
  });

  return new Promise((resolve, reject) => {
    const listener = app.listen(0, "127.0.0.1", (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(listener);
    });
  });
}