#!/usr/bin/env node

// Route all logging to stderr so stdout stays clean for ACP JSON-RPC messages
console.log = console.error;
console.info = console.error;
console.warn = console.error;
console.debug = console.error;

process.on("unhandledRejection", (reason, promise) => {
  console.error("Unhandled Rejection at:", promise, "reason:", reason);
});

process.on("uncaughtException", (error) => {
  console.error("Uncaught Exception:", error);
  process.exit(1);
});

import { ndJsonStream } from "@agentclientprotocol/sdk";
import { Readable, Writable } from "node:stream";
import { runAgent } from "./agent.js";

const input = Writable.toWeb(process.stdout) as WritableStream<Uint8Array>;
const output = Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>;
const stream = ndJsonStream(input, output);

runAgent(stream);
process.stdin.resume();