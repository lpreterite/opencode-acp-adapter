import { spawn } from "node:child_process";
import { client, methods, ndJsonStream } from "@agentclientprotocol/sdk";
import type { ClientConnection } from "@agentclientprotocol/sdk";
import { Readable, Writable } from "node:stream";

const OPENCODE_URL = process.env.OPENCODE_URL || "http://127.0.0.1:9999";
const CWD = process.env.TEST_CWD || process.cwd();

async function main() {
  console.error("=== Harness: starting adapter ===");
  const proc = spawn("node", ["./dist/index.js"], {
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      OPENCODE_URL,
      OPENCODE: "1",
      PATH: process.env.PATH,
    },
  });

  proc.stderr.on("data", (d) => process.stderr.write("[adapter] " + d));

  const input = Writable.toWeb(proc.stdin) as unknown as WritableStream<Uint8Array>;
  const output = Readable.toWeb(proc.stdout) as unknown as ReadableStream<Uint8Array>;
  const stream = ndJsonStream(input, output);

  const clientApp = client({ name: "test-harness" })
    .onRequest(methods.client.fs.readTextFile, async () => {
      console.error("[client] readTextFile called");
      return { content: "mock file content" };
    })
    .onRequest(methods.client.fs.writeTextFile, async (ctx) => {
      console.error("[client] writeTextFile:", ctx.params.path);
    })
    .onNotification(methods.client.session.update, async (ctx) => {
      console.error("[client] session/update:", JSON.stringify(ctx.params).slice(0, 200));
    });

  let conn: ClientConnection;
  try {
    conn = clientApp.connect(stream) as unknown as ClientConnection;
  } catch (e) {
    console.error("Failed to connect:", e);
    proc.kill();
    process.exit(1);
  }

  const results: { step: string; ok: boolean; detail?: any }[] = [];

  try {
    // Step 1: initialize
    console.error("\n=== Step 1: initialize ===");
    const init = await conn.agent.request(methods.agent.initialize, {
      protocolVersion: 1,
      clientInfo: { name: "test-harness", version: "1.0.0" },
      clientCapabilities: {
        sessionCapabilities: { close: {}, list: {} },
      },
    });
    const initOk = init.protocolVersion === 1 && init.agentCapabilities?.loadSession === true;
    results.push({ step: "initialize", ok: initOk, detail: { protocolVersion: init.protocolVersion } });
    console.error("  ->", initOk ? "PASS" : "FAIL", JSON.stringify(init).slice(0, 150));

    // Step 2: session/new
    console.error("\n=== Step 2: session/new ===");
    const session = await conn.agent.request(methods.agent.session.new, { cwd: CWD, mcpServers: [] });
    const sessionOk = typeof session.sessionId === "string" && session.sessionId.length > 0;
    results.push({ step: "session/new", ok: sessionOk, detail: { sessionId: session.sessionId } });
    console.error("  ->", sessionOk ? "PASS" : "FAIL", "sessionId:", session.sessionId);

    // Step 3: session/prompt (text)
    console.error("\n=== Step 3: session/prompt ===");
    const promptResult = await conn.agent.request(methods.agent.session.prompt, {
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "hello" }],
    });
    const promptOk = promptResult.stopReason === "end_turn";
    results.push({ step: "session/prompt", ok: promptOk, detail: { stopReason: promptResult.stopReason } });
    console.error("  ->", promptOk ? "PASS" : "FAIL", "stopReason:", promptResult.stopReason);

    // Step 4: session/list
    console.error("\n=== Step 4: session/list ===");
    const list = await conn.agent.request(methods.agent.session.list, {});
    const listOk = Array.isArray(list.sessions) && list.sessions.length > 0;
    results.push({ step: "session/list", ok: listOk, detail: { count: list.sessions.length } });
    console.error("  ->", listOk ? "PASS" : "FAIL", "count:", list.sessions.length);

    // Step 5: session/close
    console.error("\n=== Step 5: session/close ===");
    await conn.agent.request(methods.agent.session.close, { sessionId: session.sessionId });
    results.push({ step: "session/close", ok: true });
    console.error("  -> PASS");
  } catch (e) {
    console.error("\n=== ERROR ===");
    console.error(e);
    results.push({ step: "error", ok: false, detail: String(e) });
  } finally {
    conn.close();
    proc.kill();
  }

  // Summary
  console.error("\n=== Summary ===");
  const passed = results.filter((r) => r.ok).length;
  const total = results.length;
  for (const r of results) {
    console.error(`  ${r.ok ? "✓" : "✗"} ${r.step}`);
  }
  console.error(`\n${passed}/${total} passed`);

  // JSON output for automation
  console.log(JSON.stringify({ results, passed, total }));
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});