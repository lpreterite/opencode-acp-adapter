import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createSessionStore, type SessionRecord } from "../src/session-store.js";

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "session-store-test-"));
}

function makeRecord(sessionId: string, overrides?: Partial<SessionRecord>): SessionRecord {
  return {
    sessionId,
    cwd: "/test",
    messages: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("createSessionStore", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("should save record to file", async () => {
    const store = createSessionStore(tmpDir);
    const record = makeRecord("sess-1");

    await store.save(record);

    const filePath = join(tmpDir, "sess-1.json");
    expect(existsSync(filePath)).toBe(true);
    const saved = JSON.parse(readFileSync(filePath, "utf-8"));
    expect(saved.sessionId).toBe("sess-1");
    expect(saved.updatedAt).toBeTruthy();
  });

  it("should load a saved record", async () => {
    const store = createSessionStore(tmpDir);
    const record = makeRecord("sess-2", { cwd: "/workspace" });

    await store.save(record);
    const loaded = await store.load("sess-2");

    expect(loaded).not.toBeNull();
    expect(loaded!.sessionId).toBe("sess-2");
    expect(loaded!.cwd).toBe("/workspace");
  });

  it("should return null for non-existent session", async () => {
    const store = createSessionStore(tmpDir);

    const result = await store.load("non-existent");
    expect(result).toBeNull();
  });

  it("should list all sessions sorted by updatedAt descending", async () => {
    vi.useFakeTimers();
    const store = createSessionStore(tmpDir);

    vi.setSystemTime(new Date("2026-01-03T00:00:00.000Z"));
    await store.save(makeRecord("sess-a"));
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    await store.save(makeRecord("sess-b"));
    vi.setSystemTime(new Date("2026-01-02T00:00:00.000Z"));
    await store.save(makeRecord("sess-c"));

    const list = await store.list();
    expect(list).toHaveLength(3);
    expect(list[0].sessionId).toBe("sess-a");
    expect(list[1].sessionId).toBe("sess-c");
    expect(list[2].sessionId).toBe("sess-b");

    vi.useRealTimers();
  });

  it("should delete a session file", async () => {
    const store = createSessionStore(tmpDir);
    await store.save(makeRecord("sess-del"));

    await store.delete("sess-del");

    const filePath = join(tmpDir, "sess-del.json");
    expect(existsSync(filePath)).toBe(false);
    const loaded = await store.load("sess-del");
    expect(loaded).toBeNull();
  });

  it("should append a message to existing session", async () => {
    const store = createSessionStore(tmpDir);
    await store.save(makeRecord("sess-msg"));

    await store.appendMessage("sess-msg", {
      role: "user",
      content: "hello",
      timestamp: "2026-01-01T00:00:00.000Z",
    });

    const loaded = await store.load("sess-msg");
    expect(loaded!.messages).toHaveLength(1);
    expect(loaded!.messages[0].role).toBe("user");
    expect(loaded!.messages[0].content).toBe("hello");
  });

  it("should not append message to non-existent session", async () => {
    const store = createSessionStore(tmpDir);

    await store.appendMessage("non-existent", {
      role: "user",
      content: "test",
      timestamp: "2026-01-01T00:00:00.000Z",
    });

    const loaded = await store.load("non-existent");
    expect(loaded).toBeNull();
  });
});