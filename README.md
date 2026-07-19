# opencode-acp-adapter

将 [OpenCode](https://opencode.ai) 编码引擎以 **ACP (Agent Client Protocol)** 标准协议暴露给任何 ACP 兼容客户端。

## 架构

```
ACP 客户端 (acpx, OpenClaw, Zed 等)
    │
    │ ACP 协议 (JSON-RPC 2.0 over stdio)
    ▼
opencode-acp-adapter
    │
    │ HTTP/SSE
    ▼
OpenCode 编码引擎
```

## 前置依赖

- **Node.js** >= 18
- **[OpenCode](https://opencode.ai)** 编码引擎（运行时依赖）

  适配器通过子进程启动 OpenCode 服务。请确保 `opencode` 命令在 PATH 中可用，或通过 `OPENCODE_BIN` 环境变量指定路径。

  ```bash
  # 安装 OpenCode（参考官方文档）
  curl -fsSL https://opencode.ai/install.sh | sh
  ```

  如果不想启动子进程，可通过 `OPENCODE_URL` 环境变量连接已有的 OpenCode 服务器。

## 从源码构建

```bash
git clone https://github.com/lpreterite/opencode-acp-adapter.git
cd opencode-acp-adapter
npm install
npm run build
```

构建产物在 `dist/` 目录，可直接运行 `node dist/index.js`。

## 使用

### 启动适配器

适配器通过 stdio 与 ACP 客户端通信，所有日志输出到 stderr，stdout 保持纯净用于 JSON-RPC 消息。

```bash
# 方式一：opencode 在 PATH 中（默认）
opencode-acp-adapter

# 方式二：指定 opencode 二进制路径
OPENCODE_BIN=/path/to/opencode opencode-acp-adapter

# 方式三：连接已有 OpenCode 服务器（跳过子进程启动）
OPENCODE_URL=http://127.0.0.1:8080 opencode-acp-adapter
```

### 环境变量

| 变量 | 必要性 | 说明 |
|------|--------|------|
| `OPENCODE_URL` | 可选 | 设置后跳过子进程启动，直接连接已有 OpenCode 服务器 |
| `OPENCODE_BIN` | 可选 | 当 `opencode` 不在 PATH 中时，指定二进制路径 |
| `OPENCODE` | 通常无需手动设置 | 适配器内部自动设置，用于 OpenCode 兼容模式 |

### 与 acpx 配合使用

```bash
acpx --agent opencode-acp-adapter
```

## 测试

### 单元测试

```bash
npm test
```

77 个测试，覆盖所有模块：

| 文件 | 测试数 | 说明 |
|---|---|---|
| `test/utils.test.ts` | 9 | Pushable、sleep、unreachable、流转换 |
| `test/session-store.test.ts` | 7 | 会话持久化 save/load/list/delete |
| `test/agent-utils.test.ts` | 16 | prompt/part 事件转换 |
| `test/agent.test.ts` | 25 | 所有 11 个 ACP handler + 完整生命周期 |
| `test/opencode-client.test.ts` | 10 | HTTP 通信层 |
| `test/mcp-server.test.ts` | 10 | MCP 工具注册与调用 |

### Harness 测试（真实子进程通信）

启动 mock OpenCode 服务器，通过 stdio 与适配器子进程通信，验证完整流程：

```bash
bash test/harness/run.sh
```

验证 5 个步骤：`initialize → session/new → session/prompt → session/list → session/close`。

### 开发

```bash
# 编译
npm run build

# 开发（编译 + 启动）
npm run dev

# 类型检查
npm run typecheck

# 运行测试
npm test

# 测试监视模式
npm run test:watch

# 测试覆盖率
npm run test:coverage
```

## 协议能力

| 方法 | 支持 |
|---|---|
| `initialize` | ✅ |
| `authenticate` | ✅ |
| `session/new` | ✅ |
| `session/load` | ✅ |
| `session/resume` | ✅ |
| `session/close` | ✅ |
| `session/list` | ✅ |
| `session/prompt` | ✅ |
| `session/cancel` | ✅ |
| `session/set_mode` | ✅（降级空操作） |
| `session/set_config_option` | ✅（降级空操作） |

## 许可证

MIT © 2026 lpreterite