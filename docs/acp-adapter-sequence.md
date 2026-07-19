# ACP Adapter 时序图

## 完整链路：initialize → authenticate → session/new → session/prompt → session/close

```
ACP Client (acpx)        Adapter                         OpenCode CLI     OpenCode Server
     │                      │                               │                   │
     │── initialize ──────> │                               │                   │
     │<── protocolVersion ──│                               │                   │
     │                      │                               │                   │
     │── authenticate ─────>│                               │                   │
     │                      │── opencode models --verbose ──>│                   │
     │                      │<── { providerID/modelID, ... }─│                   │
     │                      │   (解析输出，缓存到 cachedModels)                   │
     │<── { models: {       │                               │                   │
     │   currentModelId,    │                               │                   │
     │   availableModels    │                               │                   │
     │ }} ─────────────────│                               │                   │
     │                      │                               │                   │
     │── session/new ──────>│                               │                   │
     │                      │── createMcpServer() ──────────│                   │
     │                      │   (HTTP 127.0.0.1:随机端口)   │                   │
     │                      │                               │                   │
     │                      │── startOpenCodeServer() ──────│─── spawn ───────>│
     │                      │                               │   "opencode      │
     │                      │                               │    serve"        │
     │                      │<── listening on port ─────────│──────────────────│
     │                      │                               │                   │
     │                      │── POST /session ─────────────│──────────────────>│
     │                      │<── { id: "ses_xxx" } ────────│──────────────────│
     │                      │                               │                   │
     │                      │── GET /config/providers ──────│──────────────────>│
     │                      │<── { providers, default } ────│──────────────────│
     │                      │   (ensureModels 检测 cachedModels 已存在)          │
     │                      │   (跳过，不重复请求)                               │
     │                      │                               │                   │
     │                      │── GET /event (SSE) ──────────│──────────────────>│
     │                      │   (长连接, 实时推送)          │                   │
     │                      │                               │                   │
     │<── { sessionId,      │                               │                   │
     │   configOptions } ───│                               │                   │
     │                      │                               │                   │
     │── session/prompt ───>│                               │                   │
     │                      │                               │                   │
     │   ─ ─ ─ 发起 POST ──│── POST /session/{id}/message ─│──────────────────>│
     │                      │   (fire & forget, 不 await)   │                   │
     │                      │                               │                   │── 开始处理
     │                      │   ┌───────────────────────────│───────────────────┤
     │                      │   │ SSE 事件流                │                   │
     │                      │<──┤ reasoning part            │                   │
     │<── session/update ───│   │ (agent_thought_chunk)     │                   │
     │   (reasoning chunk)  │   │ lastEventAt = T1          │                   │
     │                      │   │                           │                   │
     │                      │<──┤ tool_call part            │                   │
     │<── session/update ───│   │ (tool_call: pending)      │                   │
     │   (tool_call)        │   │ lastEventAt = T2          │                   │
     │                      │   │                           │                   │
     │                      │   │  ┌─ MCP 桥接交互 ──┐      │                   │
     │                      │   │  │                  │      │                   │
     │                      │   │  │ tools/call(read)  │      │                   │
     │                      │   │  │ ──→ readTextFile  │      │                   │
     │                      │   │  │ ←── { content }   │      │                   │
     │                      │   │  │                  │      │                   │
     │                      │   │  └──────────────────┘      │                   │
     │                      │   │                           │                   │
     │                      │<──┤ tool_call part (completed) │                   │
     │<── session/update ───│   │ (tool_call_update)         │                   │
     │   (tool_call_update) │   │ lastEventAt = T3          │                   │
     │                      │   │                           │                   │
     │                      │   │ (多轮 tool call 循环)     │                   │
     │                      │   │                           │                   │
     │                      │<──┤ step-finish part          │                   │
     │                      │   │ reason: "stop"            │                   │
     │                      │   │ ──→ resolve pendingPrompt │                   │
     │                      │   └───────────────────────────│───────────────────┤
     │                      │                               │                   │
     │<── session/prompt ───│  立即返回                      │                   │
     │   { stopReason:      │  (不等 POST 响应)             │                   │
     │     "end_turn" }     │                               │                   │
     │                      │                               │                   │
     │                      │<── POST 响应 (忽略) ──────────│──────────────────│
     │                      │   { info: { time.completed } }│                   │
     │                      │                               │                   │
     │── session/close ────>│                               │                   │
     │                      │── close SSE ──────────────────│──────────────────>│
     │                      │── stop OpenCode ─────────────│──────────────────>│
     │                      │── close MCP server ──────────│                   │
     │<── {} ───────────────│                               │                   │
```

## 模型选择场景（session/setConfigOption）

```
ACP Client                Adapter                         OpenCode Server
     │                      │                               │
     │── session/setConfigOption ──>│                       │
     │   { configId: "model",       │                       │
     │     sessionId: "sess-1",     │                       │
     │     value: "axonhub/..." }   │                       │
     │                      │── update session.selectedModel│
     │                      │   = { providerID, modelID }   │
     │<── { configOptions } │                               │
     │   (当前模型列表 +    │                               │
     │    currentValue 更新) │                               │
     │                      │                               │
     │── session/prompt ───>│                               │
     │                      │── sendPrompt({                │
     │                      │   parts,                      │
     │                      │   model: session.selectedModel│
     │                      │ }) ──────────────────────────>│
     │                      │                               │── 使用指定模型处理
     │                      │   ... SSE 事件流 ...           │
```

## session/load 和 session/resume 模型协商

```
ACP Client                Adapter                         OpenCode Server
     │                      │                               │
     │── session/load ─────>│                               │
     │   (sessionId 已存在) │                               │
     │                      │── replay messages             │
     │                      │── createOcSession()           │
     │                      │   (cachedModels 已存在，直接用) │
     │<── { configOptions } │                               │
     │                      │                               │
     │   (同 session/resume)│                               │
     │                      │                               │
     │── session/resume ───>│                               │
     │                      │── createOcSession()           │
     │                      │   (cachedModels 已存在，直接用) │
     │<── { configOptions } │                               │
```

## 静默超时场景（SSE 事件中断）

```
ACP Client              Adapter                         OpenCode
     │                      │                               │
     │── session/prompt ───>│                               │
     │                      │── POST /message ────────────> │
     │                      │   (fire & forget)             │
     │                      │   ┌───────────────────────────┤
     │<── session/update ───│   │ 最后一条事件 T            │
     │                      │   │ lastEventAt = T           │
     │                      │   │                           │
     │                      │   │ ... 10 分钟无新事件 ...    │
     │                      │   │                           │
     │                      │   │ 检查: now - lastEventAt   │
     │                      │   │ > 10min → 超时            │
     │                      │   │ ──→ resolve refusal       │
     │                      │   └───────────────────────────┤
     │                      │                               │
     │<── session/prompt ───│  stopReason: "refusal"        │
```

## 取消场景（session/cancel）

```
ACP Client              Adapter                         OpenCode
     │                      │                               │
     │── session/prompt ───>│                               │
     │                      │── POST /message ────────────> │
     │                      │   (fire & forget)             │
     │                      │                               │
     │── session/cancel ───>│                               │
     │                      │── resolve pendingPrompt ────  │
     │                      │   stopReason: "cancelled"     │
     │                      │── POST /session/{id}/abort ──>│
     │                      │                               │
     │<── session/prompt ───│  stopReason: "cancelled"      │
     │                      │                               │
     │                      │<── abort 响应 ─────────────── │
```

## 关键设计决策

### 为什么 `authenticate` 阶段获取模型？

OpenClaw/acpx 的模型校验发生在 `session/new` 之前，它检查 `authenticate` 响应中的 `models` 字段。如果 `authenticate` 返回空，OpenClaw 认为适配器不支持模型选择，抛出 `assertRequestedModelSupported` 错误。

通过 `opencode models --verbose` CLI 命令获取模型列表，不依赖 OpenCode 服务器（服务器在 `session/new` 才启动）。

### 共享缓存 `cachedModels`

`authenticate` 和 `session/new` 共享同一全局缓存：

| 阶段 | 获取方式 | 缓存状态 |
|------|---------|---------|
| `authenticate` | `opencode models --verbose` (CLI) | 写入 `cachedModels` |
| `session/new` → `ensureModels()` | `GET /config/providers` (HTTP) | 检测到已存在，跳过 |

这保证了 `authenticate` 返回的模型列表与 `session/new` 返回的 `configOptions` 一致。

### 双路模型协商

| 路径 | 协议层 | 用途 | 检查方 |
|------|--------|------|--------|
| `authenticate` 返回 `models` 字段 | ACP legacy | 预校验适配器支持模型选择 | OpenClaw `assertRequestedModelSupported()` |
| `session/new` 返回 `configOptions` | ACP 标准 | 声明可选模型列表 + 当前值 | ACP 客户端 (`acpx`) |

### 为什么 POST 是 fire & forget？

OpenCode 的 `POST /session/{id}/message` 是**同步阻塞**的 — 直到消息处理完成才返回 HTTP 响应。对于长 prompt，这会阻塞 `session/prompt` handler 的 JSON-RPC 响应。通过 fire & forget + SSE 事件驱动，可以：

1. 在 OpenCode 处理过程中实时推送进度（SSE → `session/update`）
2. 在消息完成时立即返回 `session/prompt` 响应
3. 不等 POST 响应，避免长连接阻塞

### 为什么超时是基于 SSE 事件活跃度？

SSE 事件流是 OpenCode 处理进度的实时指标。如果还有事件在推，说明 OpenCode 还在工作。只有当事件停止超过 10 分钟，才认为处理已挂起或失败。这比固定时间超时更合理。

### 数据流参考

- `session/update` 通知类型：`agent_thought_chunk`、`agent_message_chunk`、`tool_call`、`tool_call_update`
- OpenCode SSE 事件类型：`message.part.updated` → `{ type: "reasoning" | "text" | "tool" | "step-finish" }`
- 完成信号：`step-finish` + `reason: "stop"`