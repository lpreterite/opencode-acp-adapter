import { describe, it, expect, afterEach, vi } from "vitest";
import { createMcpServer, type McpAgentBridge } from "../src/mcp-server.js";
import { type Server } from "node:http";
import { readdir } from "node:fs/promises";

vi.mock("node:fs/promises", () => ({
  readdir: vi.fn(),
}));

function createMockBridge(): McpAgentBridge {
  return {
    readTextFile: vi.fn().mockResolvedValue({ content: "file content" }),
    writeTextFile: vi.fn().mockResolvedValue(undefined),
    createTerminal: vi.fn().mockResolvedValue({
      waitForExit: vi.fn().mockResolvedValue(undefined),
      currentOutput: vi.fn().mockResolvedValue({
        output: "command output",
        exitStatus: { exitCode: 0 },
      }),
      release: vi.fn().mockResolvedValue(undefined),
    }),
  };
}

async function mcpRequest(
  server: Server,
  body: Record<string, unknown>,
): Promise<{ response: any; status: number }> {
  const addr = server.address() as any;
  const url = `http://127.0.0.1:${addr.port}/mcp`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let response: any;
  if (res.headers.get("content-type")?.includes("text/event-stream")) {
    const match = text.match(/data: (.+)/);
    response = match ? JSON.parse(match[1]) : { error: { message: "no SSE data found" } };
  } else {
    response = JSON.parse(text);
  }
  return { response, status: res.status };
}

describe("createMcpServer", () => {
  afterEach(async () => {
    vi.restoreAllMocks();
  });

  it("should create a server and listen on a port", async () => {
    const bridge = createMockBridge();
    const server = await createMcpServer(bridge, "sess-1");
    expect(server.address()).toBeTruthy();
    server.close();
  });

  it("should return available tools via tools/list", async () => {
    const bridge = createMockBridge();
    const server = await createMcpServer(bridge, "sess-1", {
      fs: { readTextFile: true, writeTextFile: true },
      terminal: true,
    });

    const { response } = await mcpRequest(server, {
      jsonrpc: "2.0",
      method: "tools/list",
      id: 1,
    });

    expect(response.result).toBeDefined();
    expect(response.result.tools).toBeInstanceOf(Array);
    const toolNames = response.result.tools.map((t: any) => t.name);
    expect(toolNames).toContain("read");
    expect(toolNames).toContain("write");
    expect(toolNames).toContain("multi-edit");
    expect(toolNames).toContain("Bash");
    server.close();
  });

  it("should register read tool when readTextFile capability is declared", async () => {
    const bridge = createMockBridge();
    const server = await createMcpServer(bridge, "sess-1", {
      fs: { readTextFile: true, writeTextFile: false },
    });

    const { response } = await mcpRequest(server, {
      jsonrpc: "2.0",
      method: "tools/list",
      id: 1,
    });

    const toolNames = response.result.tools.map((t: any) => t.name);
    expect(toolNames).toContain("read");
    expect(toolNames).not.toContain("write");
    server.close();
  });

  it("should call bridge.readTextFile when read tool is invoked", async () => {
    const bridge = createMockBridge();
    const server = await createMcpServer(bridge, "sess-1", {
      fs: { readTextFile: true, writeTextFile: false },
    });

    const { response } = await mcpRequest(server, {
      jsonrpc: "2.0",
      method: "tools/call",
      id: 2,
      params: {
        name: "read",
        arguments: { abs_path: "/test/file.txt", offset: 0, limit: 10 },
      },
    });

    expect(bridge.readTextFile).toHaveBeenCalledWith(
      expect.objectContaining({ path: "/test/file.txt", sessionId: "sess-1" }),
    );
    expect(response.result).toBeDefined();
    server.close();
  });

  it("should call bridge.writeTextFile when write tool is invoked", async () => {
    const bridge = createMockBridge();
    const server = await createMcpServer(bridge, "sess-1", {
      fs: { readTextFile: false, writeTextFile: true },
    });

    await mcpRequest(server, {
      jsonrpc: "2.0",
      method: "tools/call",
      id: 3,
      params: {
        name: "write",
        arguments: { abs_path: "/test/file.txt", content: "new content" },
      },
    });

    expect(bridge.writeTextFile).toHaveBeenCalledWith(
      expect.objectContaining({ path: "/test/file.txt", content: "new content", sessionId: "sess-1" }),
    );
    server.close();
  });

  it("should always register multi-edit tool regardless of capabilities", async () => {
    const bridge = createMockBridge();
    const server = await createMcpServer(bridge, "sess-1");

    const { response } = await mcpRequest(server, {
      jsonrpc: "2.0",
      method: "tools/list",
      id: 1,
    });

    const toolNames = response.result.tools.map((t: any) => t.name);
    expect(toolNames).toContain("multi-edit");
    server.close();
  });

  it("should execute multi-edit tool", async () => {
    const bridge = createMockBridge();
    bridge.readTextFile = vi.fn().mockResolvedValue({ content: "original content here" });
    bridge.writeTextFile = vi.fn().mockResolvedValue(undefined);
    const server = await createMcpServer(bridge, "sess-1", {
      fs: { readTextFile: true, writeTextFile: true },
    });

    const { response } = await mcpRequest(server, {
      jsonrpc: "2.0",
      method: "tools/call",
      id: 4,
      params: {
        name: "multi-edit",
        arguments: {
          file_path: "/test/file.txt",
          edits: [{ old_string: "original", new_string: "modified" }],
        },
      },
    });

    expect(bridge.readTextFile).toHaveBeenCalled();
    expect(bridge.writeTextFile).toHaveBeenCalled();
    expect(response.result).toBeDefined();
    server.close();
  });

  it("should register Bash tool when terminal capability is declared", async () => {
    const bridge = createMockBridge();
    const server = await createMcpServer(bridge, "sess-1", {
      terminal: true,
    });

    const { response } = await mcpRequest(server, {
      jsonrpc: "2.0",
      method: "tools/list",
      id: 1,
    });

    const toolNames = response.result.tools.map((t: any) => t.name);
    expect(toolNames).toContain("Bash");
    server.close();
  });

  it("should not register Bash tool without terminal capability", async () => {
    const bridge = createMockBridge();
    const server = await createMcpServer(bridge, "sess-1");

    const { response } = await mcpRequest(server, {
      jsonrpc: "2.0",
      method: "tools/list",
      id: 1,
    });

    const toolNames = response.result.tools.map((t: any) => t.name);
    expect(toolNames).not.toContain("Bash");
    server.close();
  });

  it("should return error message when tool call fails", async () => {
    const bridge = createMockBridge();
    bridge.readTextFile = vi.fn().mockRejectedValue(new Error("read failed"));
    const server = await createMcpServer(bridge, "sess-1", {
      fs: { readTextFile: true, writeTextFile: false },
    });

    const { response } = await mcpRequest(server, {
      jsonrpc: "2.0",
      method: "tools/call",
      id: 5,
      params: {
        name: "read",
        arguments: { abs_path: "/test/file.txt" },
      },
    });

    const text = response.result?.content?.[0]?.text || "";
    expect(text).toContain("read failed");
    server.close();
  });

  describe("glob tool", () => {
    function createMockDirent(name: string, parentPath: string, isDir: boolean) {
      return { name, parentPath, isDirectory: () => isDir };
    }

    it("should register glob tool by default (no capabilities required)", async () => {
      const bridge = createMockBridge();
      const server = await createMcpServer(bridge, "sess-1");

      const { response } = await mcpRequest(server, {
        jsonrpc: "2.0",
        method: "tools/list",
        id: 1,
      });

      const toolNames = response.result.tools.map((t: any) => t.name);
      expect(toolNames).toContain("glob");
      server.close();
    });

    it("should list files with glob tool", async () => {
      vi.mocked(readdir).mockResolvedValue([
        createMockDirent("a.ts", "/test", false) as any,
        createMockDirent("b.ts", "/test", false) as any,
        createMockDirent("sub", "/test", true) as any,
      ]);

      const bridge = createMockBridge();
      const server = await createMcpServer(bridge, "sess-1");

      const { response } = await mcpRequest(server, {
        jsonrpc: "2.0",
        method: "tools/call",
        id: 2,
        params: {
          name: "glob",
          arguments: { path: "/test" },
        },
      });

      const text = response.result?.content?.[0]?.text || "";
      expect(text).toContain("a.ts");
      expect(text).toContain("b.ts");
      expect(text).toContain("sub/");
      server.close();
    });

    it("should return error for non-existent path", async () => {
      vi.mocked(readdir).mockRejectedValue(new Error("ENOENT: no such file or directory"));

      const bridge = createMockBridge();
      const server = await createMcpServer(bridge, "sess-1");

      const { response } = await mcpRequest(server, {
        jsonrpc: "2.0",
        method: "tools/call",
        id: 3,
        params: {
          name: "glob",
          arguments: { path: "/nonexistent" },
        },
      });

      const text = response.result?.content?.[0]?.text || "";
      expect(text).toContain("Glob failed");
      server.close();
    });
  });
});