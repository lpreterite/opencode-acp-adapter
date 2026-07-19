# 新项目：OpenCode ACP 适配器（重构版）

## 项目概述

基于官方 `@agentclientprotocol/sdk@1.2.1` 全新构建的 ACP 适配器，将 OpenCode 编码引擎以 ACP 协议标准暴露给任何 ACP 兼容客户端（OpenClaw/acpx、Zed 等）。

**架构**:
```
OpenClaw (acpx, ACP 客户端)
    ↓ ACP 协议 (JSON-RPC 2.0 over stdio)
opencode-acp (新项目)
    ↓ HTTP/SSE
OpenCode (后端引擎)
```

---

## 项目初始化

### 目录结构

```
opencode-acp/
├── package.json
├── tsconfig.json
├── .gitignore
├── README.md
├── LICENSE
├── src/
│   ├── index.ts           # CLI 入口
│   ├── agent.ts           # ACP agent 注册 + 所有 handler
│   ├── opencode-client.ts # OpenCode HTTP/SSE 通信层（从旧项目迁移）
│   ├── session-store.ts   # 会话持久化（磁盘 JSON）
│   ├── mcp-server.ts      # MCP 桥接（从旧项目迁移）
│   └── utils.ts           # 工具函数（从旧项目迁移）
├── test/
│   ├── agent.test.ts      # ACP handler 单元测试
│   ├── opencode-client.test.ts
│   ├── session-store.test.ts
│   ├── mcp-server.test.ts
│   └── integration.test.ts
└── .github/
    └── workflows/
        └── ci.yml
```

### package.json

```json
{
  "name": "opencode-acp",
  "version": "0.2.0",
  "description": "ACP-compatible adapter bridging OpenCode to any ACP client (OpenClaw, Zed, etc.)",
  "type": "module",
  "bin": {
    "opencode-acp": "./dist/index.js"
  },
  "main": "dist/index.js",
  "files": ["dist/", "README.md", "LICENSE", "package.json"],
  "scripts": {
    "build": "tsc",
    "start": "node dist/index.js",
    "dev": "npm run build && npm run start",
    "test": "vitest run",
    "test:watch": "vitest",
    "test:coverage": "vitest run --coverage",
    "lint": "tsc --noEmit",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@agentclientprotocol/sdk": "^1.2.1",
    "@modelcontextprotocol/sdk": "^1.17.4",
    "diff": "^8.0.2",
    "express": "^5.1.0",
    "minimist": "^1.2.8",
    "uuid": "^11.1.0",
    "zod": "^3.25.0"
  },
  "devDependencies": {
    "@types/diff": "^8.0.0",
    "@types/express": "^5.0.3",
    "@types/minimist": "^1.2.5",
    "@types/node": "^20.10.0",
    "typescript": "^5.4.0",
    "vitest": "^3.0.0"
  }
}
```

### tsconfig.json

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "Bundler",
    "outDir": "dist",
    "rootDir": "src",
    "esModuleInterop": true,
    "resolveJsonModule": true,
    "strict": true,
    "skipLibCheck": true,
    "types": ["node"]
  },
  "include": ["src/**/*.ts"]
}
```

### .gitignore

复用旧项目的 `.gitignore`，追加 `test-results/`、`coverage/`、`sessions/`。

---

## 模块详细设计

### 1. `src/index.ts` — CLI 入口

```typescript
#!/usr/bin/env node
// stdout: ACP JSON-RPC 消息（不可被日志污染）
// stderr: 所有日志输出
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

import { runAgent } from "./agent.js";
import { Readable, Writable } from "node:stream";
import { ndJsonStream } from "@agentclientprotocol/sdk";

const input = Writable.toWeb(process.stdout) as WritableStream<Uint8Array>;
const output = Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>;
const stream = ndJsonStream(input, output);

runAgent(stream);
process.stdin.resume();
```

### 2. `src/agent.ts` — ACP Agent 核心

使用 `@agentclientprotocol/sdk` 的 `agent()` 函数式 API，注册所有 ACP handler。

**handler 清单**:

| 方法 | 类型 | 功能 |
|---|---|---|
| `initialize` | Request | 协商版本，声明能力 |
| `authenticate` | Request | 返回空响应（不要求认证） |
| `session/new` | Request | 创建 MCP 服务器 + OpenCode 服务器 + 会话 |
| `session/load` | Request | 从磁盘加载会话，重放历史 |
| `session/resume` | Request | 从磁盘加载会话，不重放历史 |
| `session/close` | Request | 关闭会话，清理资源 |
| `session/list` | Request | 列出所有已保存的会话 |
| `session/set_mode` | Request | 设置会话模式（支持但不操作） |
| `session/set_config_option` | Request | 设置配置项（支持但不操作） |
| `session/prompt` | Request | 发送消息到 OpenCode，流式回传结果 |
| `session/cancel` | Notification | 取消当前 prompt |

**伪代码结构**:

```typescript
import { agent, methods, ndJsonStream } from "@agentclientprotocol/sdk";
import type { Stream } from "@agentclientprotocol/sdk";

interface Session {
  id: string;
  oc: { server: OpenCodeServer; sessionId: string };
  cancelled: boolean;
  activeMessageId?: string;
  partSeen: Record<string, number>;
  mcpServer: http.Server;
}

export function runAgent(stream: Stream) {
  const sessions = new Map<string, Session>();
  const sessionStore = createSessionStore();

  agent({ name: "opencode-acp" })
    .onRequest(methods.agent.initialize, async (ctx) => {
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
    })

    .onRequest(methods.agent.authenticate, async () => ({}))

    .onRequest(methods.agent.session_new, async (ctx) => {
      const { cwd, mcpServers } = ctx.params;
      const acpSessionId = crypto.randomUUID();

      // 1. 创建 MCP 桥接服务器
      const mcpServer = await createMcpServer(/* ... */);

      // 2. 启动 OpenCode 服务器
      const ocServer = await startOpenCodeServer({ cwd });

      // 3. 创建 OpenCode 会话
      const ocSession = await createSession(ocServer.url);

      // 4. 订阅 SSE 事件
      sseSubscribe(ocServer.url, (event) =>
        handleOpenCodeEvent(sessions, acpSessionId, event, ctx)
      );

      // 5. 保存会话到内存
      sessions.set(acpSessionId, { /* ... */ });

      // 6. 持久化会话元数据
      await sessionStore.save({ sessionId: acpSessionId, cwd, messages: [] });

      return { sessionId: acpSessionId };
    })

    .onRequest(methods.agent.session_load, async (ctx) => {
      const { sessionId, cwd, mcpServers } = ctx.params;
      const record = await sessionStore.load(sessionId);
      if (!record) throw new Error(`Session ${sessionId} not found`);

      // 重放消息历史
      for (const msg of record.messages) {
        const updateType = msg.role === "user"
          ? "user_message_chunk" : "agent_message_chunk";
        await ctx.notify(methods.client.session.update, {
          sessionId,
          update: { sessionUpdate: updateType, content: msg.content[0] },
        });
      }

      // 重新创建 OpenCode 会话
      // ...（同上 session_new 的 1-4 步）

      return {};
    })

    .onRequest(methods.agent.session_resume, async (ctx) => {
      const { sessionId, cwd, mcpServers } = ctx.params;
      const record = await sessionStore.load(sessionId);
      if (!record) throw new Error(`Session ${sessionId} not found`);

      // 恢复会话但不重放历史
      // ...（同上 session_new 的 1-4 步）

      return {};
    })

    .onRequest(methods.agent.session_close, async (ctx) => {
      const { sessionId } = ctx.params;
      const session = sessions.get(sessionId);
      if (!session) throw new Error(`Session ${sessionId} not found`);

      session.oc.server.stop();
      session.mcpServer.close();
      sessions.delete(sessionId);

      return {};
    })

    .onRequest(methods.agent.session_list, async (ctx) => {
      const records = await sessionStore.list();
      return {
        sessions: records.map(r => ({
          id: r.sessionId,
          cwd: r.cwd,
          createdAt: r.createdAt,
          messageCount: r.messages.length,
        })),
      };
    })

    .onRequest(methods.agent.session_set_mode, async (ctx) => {
      // OpenCode 不支持模式切换，返回空响应
      return {};
    })

    .onRequest(methods.agent.session_set_config_option, async (ctx) => {
      return {};
    })

    .onRequest(methods.agent.session_prompt, async (ctx) => {
      const session = sessions.get(ctx.params.sessionId);
      if (!session) throw new Error("Session not found");
      session.cancelled = false;

      // 1. 将 ACP prompt 转为 OpenCode parts
      const parts = promptToOpenCodeParts(ctx.params.prompt);

      // 2. 发送到 OpenCode
      const res = await sendPrompt(session.oc.server.url, session.oc.sessionId, { parts });
      session.activeMessageId = res.info.id;

      // 3. 等待完成或取消
      while (true) {
        if (session.cancelled) return { stopReason: "cancelled" };
        const info = await fetch(
          `${session.oc.server.url}/session/${session.oc.sessionId}/message/${session.activeMessageId}`
        ).then(r => r.json());
        if (info?.time?.completed) {
          session.activeMessageId = undefined;
          return { stopReason: "end_turn" };
        }
        await new Promise(r => setTimeout(r, 150));
      }
    })

    .onNotification(methods.agent.session_cancel, async (ctx) => {
      const session = sessions.get(ctx.params.sessionId);
      if (!session) return;
      session.cancelled = true;
      await abortSession(session.oc.server.url, session.oc.sessionId);
    })

    .connect(stream);
}
```

### 3. `src/opencode-client.ts` — 从旧项目迁移

**复用现有代码**（`src/opencode-client.ts`），包含：
- `startOpenCodeServer()` — 启动 OpenCode 子进程
- `httpJson()` — HTTP JSON 请求工具
- `createSession()` — 创建 OpenCode 会话
- `sendPrompt()` — 发送消息
- `abortSession()` — 中止会话
- `sseSubscribe()` — 订阅 SSE 事件流

**改动**：移除对 `@zed-industries/agent-client-protocol` 的依赖，类型定义自包含。

### 4. `src/session-store.ts` — 新建

**路径**: `~/.opencode-acp/sessions/`

```typescript
export interface MessageRecord {
  role: "user" | "assistant";
  content: ContentBlock[];
  timestamp: string;
}

export interface SessionRecord {
  sessionId: string;
  cwd: string;
  messages: MessageRecord[];
  createdAt: string;
  updatedAt: string;
}

export function createSessionStore() {
  const baseDir = path.join(os.homedir(), ".opencode-acp", "sessions");

  function filePath(id: string): string {
    return path.join(baseDir, `${id}.json`);
  }

  return {
    async save(record: SessionRecord): Promise<void> {
      await fs.mkdir(baseDir, { recursive: true });
      record.updatedAt = new Date().toISOString();
      await fs.writeFile(filePath(record.sessionId), JSON.stringify(record, null, 2));
    },

    async load(sessionId: string): Promise<SessionRecord | null> {
      try {
        const data = await fs.readFile(filePath(sessionId), "utf-8");
        return JSON.parse(data);
      } catch { return null; }
    },

    async list(): Promise<SessionRecord[]> {
      await fs.mkdir(baseDir, { recursive: true });
      const files = await fs.readdir(baseDir);
      const records: SessionRecord[] = [];
      for (const f of files) {
        if (f.endsWith(".json")) {
          const data = await fs.readFile(path.join(baseDir, f), "utf-8");
          records.push(JSON.parse(data));
        }
      }
      return records.sort((a, b) =>
        new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
      );
    },

    async delete(sessionId: string): Promise<void> {
      await fs.rm(filePath(sessionId), { force: true });
    },

    async appendMessage(sessionId: string, msg: MessageRecord): Promise<void> {
      const record = await this.load(sessionId);
      if (record) {
        record.messages.push(msg);
        await this.save(record);
      }
    },
  };
}
```

### 5. `src/mcp-server.ts` — 从旧项目迁移

**复用现有代码**（`src/mcp-server.ts`），包含：
- `createMcpServer()` — 创建 Express + MCP 服务器
- 注册 MCP 工具：`read`、`write`、`multi-edit`、`Bash`
- 工具通过 ACP 回调到客户端

**改动**：
- 移除对 `@zed-industries/agent-client-protocol` 的 `ClientCapabilities` 依赖
- 改用 `AgentContext` 中的 `request()` 方法进行文件/终端操作

### 6. `src/utils.ts` — 从旧项目迁移

**复用现有代码**，包含：
- `Pushable<T>` — 可推送的异步迭代器
- `nodeToWebWritable()` / `nodeToWebReadable()` — 流转换
- `unreachable()` — 类型守卫
- `sleep()` — 延迟工具

---

## 事件翻译（OpenCode SSE → ACP session/update）

| OpenCode 事件 | ACP 通知 | 说明 |
|---|---|---|
| `message.part.updated` (type: text) | `agent_message_chunk` | 流式文本 |
| `message.part.updated` (type: reasoning) | `agent_thought_chunk` | 推理过程 |
| `message.part.updated` (type: tool, state: running) | `tool_call` | 工具调用开始 |
| `message.part.updated` (type: tool, state: completed) | `tool_call_update` | 工具调用完成 |
| `message.part.updated` (type: tool, state: error) | `tool_call_update` (status: failed) | 工具调用失败 |
| `message.updated` (completed) | 响应 `session/prompt` | 回合结束 |

---

## 测试计划

### 测试框架

使用 **vitest**（零配置，与 TypeScript 原生兼容）。

### 测试文件结构

```
test/
├── agent.test.ts              # ACP handler 单元测试
├── opencode-client.test.ts    # OpenCode 通信层测试
├── session-store.test.ts      # 会话持久化测试
├── mcp-server.test.ts         # MCP 桥接测试
├── utils.test.ts              # 工具函数测试
└── integration.test.ts        # 端到端集成测试
```

### 测试用例清单

#### `test/agent.test.ts` — ACP handler 测试

```
✅ initialize 返回正确的协议版本和能力声明
  - 验证 protocolVersion === 1
  - 验证 agentCapabilities.loadSession === true
  - 验证 sessionCapabilities 包含 resume、close、list
  - 验证 promptCapabilities 包含 image 和 embeddedContext

✅ authenticate 返回空对象（不要求认证）

✅ session/new 创建会话并返回 sessionId
  - 验证返回的 sessionId 是字符串
  - 验证 session 被注册到内存 Map

✅ session/load 对不存在的 sessionId 返回错误

✅ session/close 清理会话资源
  - 验证 session 从内存 Map 中移除

✅ session/list 返回会话列表

✅ session/prompt 对不存在的 sessionId 返回错误

✅ session/cancel 标记会话为取消状态
  - 验证 cancelled 标志被设置

✅ session/set_mode 返回空（降级处理）

✅ session/set_config_option 返回空（降级处理）
```

#### `test/opencode-client.test.ts` — OpenCode 通信层测试

```
✅ startOpenCodeServer 使用 OPENCODE_URL 环境变量跳过启动
  - 设置 OPENCODE_URL=http://localhost:3000
  - 验证返回的 url 匹配
  - 验证 stop() 无错误

✅ startOpenCodeServer 在找不到 opencode 二进制时抛出错误

✅ httpJson 发送正确的 HTTP 请求

✅ httpJson 在非 2xx 响应时抛出错误

✅ createSession 返回会话信息

✅ sendPrompt 发送消息并返回结果

✅ abortSession 发送中止请求

✅ sseSubscribe 解析 SSE 事件流
```

#### `test/session-store.test.ts` — 会话持久化测试

```
✅ save 创建文件并写入 JSON
  - 使用临时目录验证文件存在

✅ load 读取已保存的会话

✅ load 对不存在的会话返回 null

✅ list 返回所有会话，按更新时间降序

✅ delete 删除会话文件

✅ appendMessage 追加消息到已有会话
```

#### `test/mcp-server.test.ts` — MCP 桥接测试

```
✅ createMcpServer 创建 HTTP 服务器并监听端口

✅ MCP 服务器 POST /mcp 返回 JSON-RPC 响应

✅ 注册 MCP read 工具（仅在客户端声明 readTextFile 能力时）
```

#### `test/utils.test.ts` — 工具函数测试

```
✅ Pushable 支持 push 和 async 迭代

✅ Pushable 支持 end() 结束迭代

✅ sleep 等待指定时间

✅ unreachable 抛出错误
```

#### `test/integration.test.ts` — 集成测试

```
✅ 完整 ACP 会话生命周期：initialize → session/new → session/prompt → session/close

✅ 会话加载流程：initialize → session/new → 发送 prompt → session/close → session/load

✅ 会话取消流程：session/prompt → session/cancel → 验证 stopReason === "cancelled"

✅ 多个会话并行：创建 2 个 session，分别发送 prompt，验证各自独立
```

### 测试脚本

```bash
# 运行所有测试
npm test

# 运行测试并生成覆盖率
npm run test:coverage

# 监视模式
npm run test:watch
```

---

## CI/CD 配置

`.github/workflows/ci.yml`:

```yaml
name: CI
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: "20" }
      - run: npm ci
      - run: npm run typecheck
      - run: npm test
      - run: npm run build
```

---

## 开发工作流

```bash
# 初始化
git init
npm install

# 开发
npm run dev          # 编译并启动
npm run test:watch   # 测试监视模式

# 验证
npm run typecheck    # 类型检查
npm test             # 运行测试
npm run build        # 编译

# 链接到全局
npm link
opencode-acp         # 测试适配器
```

---

## 执行步骤

| 步骤 | 内容 | 预计文件数 |
|---|---|---|
| 1 | 创建项目目录、`package.json`、`tsconfig.json`、`.gitignore` | 4 |
| 2 | `npm install` 安装所有依赖 | 1 |
| 3 | 迁移 `src/utils.ts`（无改动） | 1 |
| 4 | 迁移 `src/opencode-client.ts`（移除旧 SDK 依赖） | 1 |
| 5 | 迁移 `src/mcp-server.ts`（适配新 SDK 上下文） | 1 |
| 6 | 新建 `src/session-store.ts` | 1 |
| 7 | 新建 `src/agent.ts`（核心，使用 `agent()` API） | 1 |
| 8 | 新建 `src/index.ts` | 1 |
| 9 | 编写测试：`session-store.test.ts`、`utils.test.ts` | 2 |
| 10 | 编写测试：`agent.test.ts`、`opencode-client.test.ts`、`mcp-server.test.ts` | 3 |
| 11 | 编写测试：`integration.test.ts` | 1 |
| 12 | `npm run typecheck && npm test` 验证通过 | — |
| 13 | 编写 `README.md` | 1 |
| 14 | 配置 `.github/workflows/ci.yml` | 1 |

---

## 测试执行计划

### 测试基础设施

```typescript
// vitest.config.ts
import { defineConfig } from "vitest/config";
export default defineConfig({
  test: { globals: true, environment: "node", include: ["test/**/*.test.ts"] },
});
```

### 测试文件分层

#### Phase 1: 基础设施 + 纯逻辑测试

| 文件 | 内容 |
|---|---|
| `test/utils.test.ts` | Pushable / sleep / unreachable / 流转换 |
| `test/session-store.test.ts` | 用临时目录测试 save/load/list/delete/appendMessage |
| `test/agent-utils.test.ts` | promptToOpenCodeParts / partToAcpNotifications 纯函数 |

#### Phase 2: agent.ts 重构 + ACP 核心测试

**重构**：`src/agent.ts` 拆分为 `createAgentApp()` + `runAgent()`，`createAgentApp()` 返回 `AgentApp` 实例供测试使用。

**测试**：`test/agent.test.ts` — 利用 SDK `ClientApp` 进程内连接模式，mock 外部依赖，覆盖所有 handler。

#### Phase 3: HTTP 层测试

| 文件 | 内容 |
|---|---|
| `test/opencode-client.test.ts` | 用临时 HTTP 服务器测试 httpJson/createSession/sendPrompt/abortSession/sseSubscribe |
| `test/mcp-server.test.ts` | 创建 MCP 服务器，POST JSON-RPC 验证工具注册和响应 |

#### Backlog: 集成测试

`test/integration.test.ts` — 端到端生命周期测试，需 mock 整个 OpenCode HTTP 服务器，推迟实现。

### 执行顺序

```
Phase 1:  Step 1 vitest.config.ts → Step 2~4 纯逻辑测试
Phase 2:  Step 5 重构 agent.ts → Step 6 agent.test.ts
Phase 3:  Step 7~8 HTTP 层测试
Backlog:  Step 9 集成测试
```

### Mock 策略

| 外部依赖 | mock 方式 |
|---|---|
| `fetch` 调用 | `http.createServer` 临时 HTTP 服务器 |
| `opencode` 二进制 | `OPENCODE_URL` 环境变量跳过子进程 |
| 客户端 fs/terminal | `ClientApp` 上注册 handler 返回 mock 数据 |
| 文件系统 | `fs.mkdtemp` 临时目录 |
| SSE 事件 | 临时 HTTP 服务器发送 `data: {...}\n\n` |

- @agentclientprotocol/sdk: https://www.npmjs.com/package/@agentclientprotocol/sdk
- 官方 SDK 示例: https://github.com/agentclientprotocol/typescript-sdk/tree/main/src/examples
- ACP 协议文档: https://agentclientprotocol.com
- 旧项目参考: https://github.com/josephschmitt/opencode-acp
- OpenClaw acpx: https://github.com/openclaw/acpx