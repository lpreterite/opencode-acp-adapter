import { describe, it, expect } from "vitest";
import { promptToOpenCodeParts, partToAcpNotifications } from "../src/agent.js";

describe("promptToOpenCodeParts", () => {
  it("should convert text chunks", () => {
    const result = promptToOpenCodeParts([{ type: "text", text: "hello world" }]);
    expect(result).toEqual([{ type: "text", text: "hello world" }]);
  });

  it("should convert resource_link to text", () => {
    const result = promptToOpenCodeParts([{ type: "resource_link", uri: "file:///a.txt" }]);
    expect(result).toEqual([{ type: "text", text: "file:///a.txt" }]);
  });

  it("should convert resource with text to text", () => {
    const result = promptToOpenCodeParts([{ type: "resource", resource: { text: "file content" } }]);
    expect(result).toEqual([{ type: "text", text: "file content" }]);
  });

  it("should skip resource without text", () => {
    const result = promptToOpenCodeParts([{ type: "resource", resource: { uri: "file:///a.txt" } }]);
    expect(result).toEqual([]);
  });

  it("should convert image with base64 data to file part", () => {
    const result = promptToOpenCodeParts([
      { type: "image", data: "base64data", mimeType: "image/png" },
    ]);
    expect(result).toEqual([
      { type: "file", url: "data:image/png;base64,base64data", mime: "image/png" },
    ]);
  });

  it("should convert image with uri to file part", () => {
    const result = promptToOpenCodeParts([
      { type: "image", uri: "https://example.com/img.png", mimeType: "image/png" },
    ]);
    expect(result).toEqual([
      { type: "file", url: "https://example.com/img.png", mime: "image/png" },
    ]);
  });

  it("should handle empty prompt array", () => {
    const result = promptToOpenCodeParts([]);
    expect(result).toEqual([]);
  });

  it("should handle multiple chunks in order", () => {
    const result = promptToOpenCodeParts([
      { type: "text", text: "hello" },
      { type: "text", text: " world" },
    ]);
    expect(result).toEqual([
      { type: "text", text: "hello" },
      { type: "text", text: " world" },
    ]);
  });
});

describe("partToAcpNotifications", () => {
  it("should emit agent_message_chunk for text part", () => {
    const part = { id: "p1", type: "text", text: "hello" };
    const seen: Record<string, number> = {};

    const notifications = partToAcpNotifications(part, "session-1", seen);

    expect(notifications).toHaveLength(1);
    expect(notifications[0].update.sessionUpdate).toBe("agent_message_chunk");
    expect(notifications[0].update.content.text).toBe("hello");
  });

  it("should emit only delta for partially seen text part", () => {
    const part = { id: "p1", type: "text", text: "hello world" };
    const seen: Record<string, number> = { p1: 6 };

    const notifications = partToAcpNotifications(part, "session-1", seen);

    expect(notifications).toHaveLength(1);
    expect(notifications[0].update.content.text).toBe("world");
  });

  it("should not emit notification for fully seen text part", () => {
    const part = { id: "p1", type: "text", text: "hello" };
    const seen: Record<string, number> = { p1: 5 };

    const notifications = partToAcpNotifications(part, "session-1", seen);

    expect(notifications).toHaveLength(0);
  });

  it("should emit agent_thought_chunk for reasoning part", () => {
    const part = { id: "r1", type: "reasoning", text: "thinking..." };
    const seen: Record<string, number> = {};

    const notifications = partToAcpNotifications(part, "session-1", seen);

    expect(notifications).toHaveLength(1);
    expect(notifications[0].update.sessionUpdate).toBe("agent_thought_chunk");
    expect(notifications[0].update.content.text).toBe("thinking...");
  });

  it("should emit tool_call for running tool part", () => {
    const part = {
      id: "t1",
      type: "tool",
      tool: "read",
      state: { status: "running", input: '{"path": "/a.txt"}' },
    };
    const seen: Record<string, number> = {};

    const notifications = partToAcpNotifications(part, "session-1", seen);

    expect(notifications).toHaveLength(1);
    expect(notifications[0].update.sessionUpdate).toBe("tool_call");
    expect(notifications[0].update.status).toBe("pending");
    expect(notifications[0].update.title).toBe("read");
  });

  it("should emit tool_call_update for completed tool part", () => {
    const part = {
      id: "t1",
      type: "tool",
      tool: "read",
      callID: "call-1",
      state: { status: "completed", output: "file content" },
    };
    const seen: Record<string, number> = {};

    const notifications = partToAcpNotifications(part, "session-1", seen);

    expect(notifications).toHaveLength(1);
    expect(notifications[0].update.sessionUpdate).toBe("tool_call_update");
    expect(notifications[0].update.status).toBe("completed");
    expect(notifications[0].update.content[0].content.text).toBe("file content");
  });

  it("should emit tool_call_update with failed status for error tool part", () => {
    const part = {
      id: "t1",
      type: "tool",
      tool: "read",
      state: { status: "error", output: "permission denied" },
    };
    const seen: Record<string, number> = {};

    const notifications = partToAcpNotifications(part, "session-1", seen);

    expect(notifications).toHaveLength(1);
    expect(notifications[0].update.sessionUpdate).toBe("tool_call_update");
    expect(notifications[0].update.status).toBe("failed");
  });

  it("should handle multiple notifications from same part", () => {
    const part = {
      id: "t1",
      type: "tool",
      tool: "read",
      state: { status: "running", input: "{}" },
    };
    const seen: Record<string, number> = {};

    const running = partToAcpNotifications(part, "session-1", seen);

    const completedPart = {
      id: "t1",
      type: "tool",
      tool: "read",
      state: { status: "completed", output: "content" },
    };
    const completed = partToAcpNotifications(completedPart, "session-1", seen);

    expect(running).toHaveLength(1);
    expect(running[0].update.sessionUpdate).toBe("tool_call");
    expect(completed).toHaveLength(1);
    expect(completed[0].update.sessionUpdate).toBe("tool_call_update");
  });
});