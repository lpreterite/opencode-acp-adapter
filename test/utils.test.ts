import { describe, it, expect, vi, afterEach } from "vitest";
import { Pushable, sleep, unreachable, nodeToWebWritable, nodeToWebReadable } from "../src/utils.js";
import { Writable, Readable, PassThrough } from "node:stream";

describe("Pushable", () => {
  it("should push and iterate items", async () => {
    const p = new Pushable<number>();
    p.push(1);
    p.push(2);
    p.end();

    const result: number[] = [];
    for await (const v of p) {
      result.push(v);
    }
    expect(result).toEqual([1, 2]);
  });

  it("should support async push and await", async () => {
    const p = new Pushable<number>();

    setTimeout(() => {
      p.push(42);
      p.end();
    }, 10);

    const result: number[] = [];
    for await (const v of p) {
      result.push(v);
    }
    expect(result).toEqual([42]);
  });

  it("should end iteration when end() is called before reading", async () => {
    const p = new Pushable<string>();
    p.end();

    const result: string[] = [];
    for await (const v of p) {
      result.push(v);
    }
    expect(result).toEqual([]);
  });

  it("should handle mixed push and async iteration", async () => {
    const p = new Pushable<number>();
    p.push(1);

    setTimeout(() => {
      p.push(3);
      p.end();
    }, 10);

    p.push(2);

    const result: number[] = [];
    for await (const v of p) {
      result.push(v);
    }
    expect(result).toEqual([1, 2, 3]);
  });
});

describe("sleep", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("should resolve after specified time", async () => {
    vi.useFakeTimers();
    const promise = sleep(100);
    vi.advanceTimersByTime(100);
    await expect(promise).resolves.toBeUndefined();
  });
});

describe("unreachable", () => {
  it("should throw an error with the value", () => {
    expect(() => unreachable("test")).toThrow("Unexpected case: test");
  });

  it("should throw for numeric values", () => {
    expect(() => unreachable(42 as never)).toThrow("Unexpected case: 42");
  });
});

describe("nodeToWebWritable", () => {
  it("should write data to underlying node stream", async () => {
    const nodeStream = new PassThrough();
    const webStream = nodeToWebWritable(nodeStream);

    const chunks: Buffer[] = [];
    nodeStream.on("data", (chunk: Buffer) => chunks.push(chunk));

    const writer = webStream.getWriter();
    await writer.write(new Uint8Array([1, 2, 3]));
    await writer.close();

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(Buffer.concat(chunks)).toEqual(Buffer.from([1, 2, 3]));
  });
});

describe("nodeToWebReadable", () => {
  it("should read data from underlying node stream", async () => {
    const nodeStream = new PassThrough();
    const webStream = nodeToWebReadable(nodeStream);

    nodeStream.write(Buffer.from([4, 5, 6]));
    nodeStream.end();

    const reader = webStream.getReader();
    const { value, done } = await reader.read();
    expect(done).toBe(false);
    expect(Array.from(value!)).toEqual([4, 5, 6]);

    const { done: done2 } = await reader.read();
    expect(done2).toBe(true);
  });
});