import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMcpBridge, type McpAgentBridge } from "../src/agent.js";
import { readFile, writeFile } from "node:fs/promises";

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
}));

function createMockClient() {
  const request = vi.fn();
  return { request };
}

describe("createMcpBridge", () => {
  let client: ReturnType<typeof createMockClient>;

  beforeEach(() => {
    client = createMockClient();
    vi.clearAllMocks();
  });

  describe("readTextFile", () => {
    it("should use ACP client when available", async () => {
      client.request.mockResolvedValue({ content: "client content" });
      const bridge = createMcpBridge(client as any);

      const result = await bridge.readTextFile({ sessionId: "sess-1", path: "/test/file.txt" });

      expect(client.request).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ path: "/test/file.txt" }),
      );
      expect(result).toEqual({ content: "client content" });
      expect(readFile).not.toHaveBeenCalled();
    });

    it("should fall back to local fs when ACP client fails", async () => {
      client.request.mockRejectedValue(new Error("Method not found"));
      vi.mocked(readFile).mockResolvedValue("local file content");
      const bridge = createMcpBridge(client as any);

      const result = await bridge.readTextFile({ sessionId: "sess-1", path: "/test/file.txt" });

      expect(client.request).toHaveBeenCalled();
      expect(readFile).toHaveBeenCalledWith("/test/file.txt", "utf-8");
      expect(result).toEqual({ content: "local file content" });
    });
  });

  describe("writeTextFile", () => {
    it("should use ACP client when available", async () => {
      client.request.mockResolvedValue(undefined);
      const bridge = createMcpBridge(client as any);

      await bridge.writeTextFile({ sessionId: "sess-1", path: "/test/file.txt", content: "new content" });

      expect(client.request).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ path: "/test/file.txt", content: "new content" }),
      );
      expect(writeFile).not.toHaveBeenCalled();
    });

    it("should fall back to local fs when ACP client fails", async () => {
      client.request.mockRejectedValue(new Error("Method not found"));
      vi.mocked(writeFile).mockResolvedValue(undefined);
      const bridge = createMcpBridge(client as any);

      await bridge.writeTextFile({ sessionId: "sess-1", path: "/test/file.txt", content: "new content" });

      expect(client.request).toHaveBeenCalled();
      expect(writeFile).toHaveBeenCalledWith("/test/file.txt", "new content", "utf-8");
    });
  });
});