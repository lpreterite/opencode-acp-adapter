# 手动测试指引：OpenClaw + opencode-acp-adapter → wx-mp 目录

## 前提条件

| 项目 | 说明 |
|---|---|
| `opencode-acp-adapter` 已构建 | `npm run build` |
| `opencode` ≥ 1.18 已安装 | `which opencode` |
| `wx-mp` 目录存在 | `/Users/packy/Documents/Works/projects/wx-mp` |
| OpenClaw + acpx 插件已安装 | 参见 OpenClaw 文档 |

## 适配器就绪检查

```bash
which opencode-acp-adapter
# 预期输出: 二进制路径，确认在 PATH 中
```

## 完整工作流程

### 第 1 步：初始化握手

适配器自动响应 `initialize`，返回：

```json
{
  "protocolVersion": 1,
  "agentCapabilities": {
    "loadSession": true,
    "sessionCapabilities": { "resume": {}, "close": {}, "list": {} },
    "promptCapabilities": { "image": true, "embeddedContext": true }
  },
  "authMethods": []
}
```

### 第 2 步：创建会话（指定 wx-mp 目录）

参数中的 `cwd` 指向 wx-mp 目录：

```json
{
  "method": "session/new",
  "params": {
    "cwd": "/Users/packy/Documents/Works/projects/wx-mp"
  }
}
```

**预期行为**：
- 适配器启动 `opencode serve` 子进程，工作目录为 wx-mp
- 适配器启动 MCP 桥接服务器（随机端口）
- 适配器通过 SSE 订阅 OpenCode 事件流
- 返回 `{ "sessionId": "uuid-string" }`

### 第 3 步：发送提示词

```json
{
  "method": "session/prompt",
  "params": {
    "sessionId": "上一步返回的 sessionId",
    "prompt": [
      { "type": "text", "text": "列出 wx-mp 目录下的所有文件" }
    ]
  }
}
```

**预期行为**：
- 适配器将 prompt 转发到 OpenCode
- OpenCode 开始处理，适配器通过 SSE 接收事件
- 事件翻译为 ACP `session/update` 通知发送给 OpenClaw
- 工具调用（read/write/bash）通过 MCP 桥接 → ACP 回调到 OpenClaw 执行
- 处理完成后返回 `{ "stopReason": "end_turn" }`

### 第 4 步：操作 wx-mp 目录

| 提示词 | 验证点 |
|---|---|
| `"列出 wx-mp 目录下的所有文件"` | 返回文件列表，包含 `news/`、`newspic/` 等 |
| `"读取 README.md 的内容"` | 返回 README 文件内容 |
| `"在 news 目录下创建一个新文件 test.md，内容为 hello"` | 文件被创建 |
| `"执行 ls -la 查看目录结构"` | 终端输出 |

### 第 5 步：关闭会话

```json
{
  "method": "session/close",
  "params": {
    "sessionId": "要关闭的 sessionId"
  }
}
```

**预期行为**：关闭 SSE 连接、停止 OpenCode 子进程、关闭 MCP 服务器、清理会话。

## 适配器日志

所有日志输出到 stderr，stdout 保持纯净用于 ACP JSON-RPC 通信：

```bash
opencode-acp-adapter 2> adapter.log
```

| 日志内容 | 含义 |
|---|---|
| `[opencode-client] starting server` | 正在启动 OpenCode 子进程 |
| `[opencode-client] server started` | OpenCode 就绪 |
| `[mcp-server] listening on port XXXX` | MCP 桥接服务器已启动 |
| `event handling error` | SSE 事件处理异常 |

## 异常排查

| 现象 | 可能原因 | 解决 |
|---|---|---|
| OpenClaw 连不上适配器 | 适配器不在 PATH | `npm link` 或指定完整路径 |
| 创建会话失败 | OpenCode 未安装或不兼容 | `opencode --version` 确认 ≥ 1.18 |
| 提示词超时 | wx-mp 目录过大或提示词复杂 | 简化提示词，检查 OpenCode 日志 |
| 文件操作失败 | MCP 权限问题 | 确认 OpenClaw 的 client handler 注册了 `fs/readTextFile` 和 `fs/writeTextFile` |

## 验证清单

- [ ] 第 1 步：适配器初始化成功
- [ ] 第 2 步：会话创建成功，返回 sessionId
- [ ] 第 3 步：提示词正常返回，无超时
- [ ] 第 4 步：文件列表正确
- [ ] 第 4 步：文件读取正常
- [ ] 第 4 步：文件写入/编辑正常
- [ ] 第 5 步：会话关闭无残留进程