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

## 安装

```bash
npm install -g opencode-acp-adapter
```

或者从源码构建：

```bash
git clone https://github.com/lpreterite/opencode-acp-adapter.git
cd opencode-acp-adapter
npm install
npm run build
npm link
```

## 使用

### 启动适配器

```bash
opencode-acp-adapter
```

适配器通过 stdio 与 ACP 客户端通信，所有日志输出到 stderr，stdout 保持纯净用于 JSON-RPC 消息。

### 环境变量

| 变量 | 说明 |
|---|---|
| `OPENCODE_URL` | 直接连接已有 OpenCode 服务器，跳过子进程启动 |
| `OPENCODE_BIN` | 指定 opencode 二进制路径（默认从 PATH 查找） |

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