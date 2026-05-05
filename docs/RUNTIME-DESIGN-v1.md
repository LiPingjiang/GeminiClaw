# GeminiClaw Runtime Design v1

> **状态：** 设计稿（含 Agent 框架选型分析）
> **作者：** 李平江 + 观澜
> **日期：** 2026-05-05（更新：2026-05-05 深夜）
> **语言：** TypeScript（全栈统一，不引入 Python）

---

## 一、背景与决策依据

### 1.1 现状差距

当前 GeminiClaw（新版）已完成：
- 基础运行时（Fastify HTTP server + multi-provider routing + layered memory）
- Evolution Engine Phase A-B（TraceCollector + Mutator + Validator L1 + Switcher）

**与旧版（GeminiClaw2 = OpenClaw fork）的核心差距：**

| 能力 | 旧版 | 新版 | 优先级 |
|------|------|------|--------|
| Agent Loop（工具调用循环） | ✅ OpenClaw 完整实现 | ❌ 只有聊天 API | P0 |
| 核心工具（exec/read/write等） | ✅ 30+ 工具 | ❌ | P0 |
| QQBot 渠道 | ✅ | ❌ | P1 |
| Session 管理（持久化/搜索） | ✅ JSONL（有损坏风险）| ⚠️ 内存 buffer | P1 |
| Control UI | ✅ OpenClaw WebChat | ❌ | P2 |
| Plugin 系统 | ✅ 重（40+ registerXxx）| ❌ | P3 |
| 多模型（14个）| ✅ | ⚠️ 仅3个 | 配置问题 |

### 1.2 参考对象

| 项目 | 参考点 | 本地路径 |
|------|--------|---------|
| OpenClaw | Agent Loop 结构、工具清单、QQBot channel | `~/Codes/GeminiClaw2/` |
| Hermes | 工具注册机制、Session SQLite 设计、Plugin 目录约定、QQBot adapter | `~/Codes/ai/hermes-agent/` |
| Pi（@mariozechner） | **Session Tree 设计**、EventStream 异步迭代器、beforeToolCall/afterToolCall 钩子 | `~/Codes/GeminiClaw2/node_modules/@mariozechner/pi-agent-core/` |

**核心原则：借鉴 hermes 的轻量设计哲学；从 Pi 汲取 Session Tree 这一独门架构思想；不照搬 OpenClaw 的重 plugin 系统。**

---

## 〇、Agent 框架选型（2026-05-05 深夜补充）

> 在动手实现 Agent Loop 之前，我们对三个主流参考做了完整横向对比，结论直接影响后续设计。

### 0.1 三个框架是什么

**Hermes — 完全自研 Python Loop**

`AIAgent` 类（`run_agent.py`，14000 行），无任何第三方 Agent 框架依赖。
`run_conversation()` 是核心 while 循环：预压缩 → plugin pre_hook → 调 LLM → 工具调用 → 循环。
工具注册：装饰器 `@registry.register()`，文件级自注册，目录发现，69 个工具。

**Pi（@mariozechner/pi-agent-core）— TypeScript 函数式 Loop**

OpenClaw 的底层 Agent 框架（`@mariozechner/pi-agent-core` v0.71.1，Mario Zechner 个人维护）。
`agentLoop()` 纯函数，返回 `EventStream<AgentEvent>` 异步迭代器。
两个关键钩子：`beforeToolCall`（可 block 工具）、`afterToolCall`（可 override 结果）。
**最核心亮点：Session 是树，不是列表**（见 0.3 节）。

**OpenAI Agents SDK / PydanticAI — Python 声明式框架**

`@agent.tool` 装饰器注册工具，Pydantic 校验参数，原生 MCP 支持。
AutoGen 已进入 maintenance mode，微软推 Microsoft Agent Framework 接班。

### 0.2 横向对比

| 维度 | Hermes（自研） | Pi（@mariozechner） | OpenAI Agents SDK |
|------|------|------|------|
| 语言 | Python | TypeScript | Python |
| Session 结构 | ❌ 线性 | ✅ **树（branch/rewind）** | ❌ 线性 |
| Context 压缩 | ✅ 内置，多 pass | ❌ 靠 transformContext 钩子 | ❌ 无 |
| 多模型 fallback | ✅ 内置 | ❌ 靠 getApiKey 钩子 | ❌ 无 |
| 工具结果持久化 | ✅ 内置，超限落盘 | ❌ 无 | ❌ 无 |
| MCP 支持 | ❌ | ❌（哲学反对）| ✅ 原生 |
| 类型安全 | Python 运行时 | TypeScript 编译期 + typebox | Python + Pydantic |
| 外部依赖 | 零 | 3 个 @mariozechner 包 | openai-agents |
| 流式 API | stream_callback 回调 | EventStream 异步迭代器 | 异步生成器 |
| 工具并行 | ThreadPoolExecutor | `toolExecution: "parallel"` | 内置自动 |
| 扩展钩子 | plugin pre/post_llm_call | beforeToolCall / afterToolCall | Guardrails / Handoffs |

### 0.3 Pi 的 Session Tree — 最值得移植的设计思想

Pi 与所有其他框架的**根本区别**：Session 不是一条线，而是一棵树。

```
主线 session（用户对话）
├── turn 1: 用户问问题
├── turn 2: 助手回答
├── branch A: 去修一个 broken tool（支线）
│   ├── 写代码
│   ├── 测试
│   └── 修好了 → merge summary 回主线
└── turn 3: 继续主线（Pi 自动 summarize 支线发生了什么）
```

**为什么 GeminiClaw 需要 Session Tree？**

Evolution Engine 的核心流程天然是树形的：

```
主线 session（用户对话）
└── evolution branch（改代码的支线）
    ├── Mutator 轮次 1：读文件 → 生成 diff → 应用
    ├── Mutator 轮次 2：tsc 报错 → 修复
    ├── Validator：跑测试
    └── 成功 → squash merge 回 main，summary 注入主线
        失败 → revert，支线废弃，主线感知到
```

如果 Session 是线性列表，Evolution Engine 的修代码过程会污染用户对话的 context。
如果 Session 是树，evolution branch 完全隔离，主线只看到最终的 summary。

**这正是 GeminiClaw「维护用户思绪」设计原则的技术基础。**

### 0.4 选型决策

| 选项 | 评价 |
|------|------|
| ❌ 直接依赖 Pi 包 | 个人维护，API 随时变，版本锁死 |
| ❌ 照搬 Hermes 风格（Python 自研） | GeminiClaw 是 TypeScript，跨语言迁移成本高 |
| ❌ OpenAI Agents SDK / PydanticAI | Python，且与 OpenAI 强绑定 |
| ✅ **自实现 TypeScript Loop，Session 设计为树** | 语言统一，接口自控，Pi 的 EventStream + 钩子模式是目前最干净的 TypeScript Agent 设计 |

**最终决策：自实现 TypeScript Agent Loop，不依赖 Pi 包，但移植 Pi 的两个核心设计思想：**
1. **Session Tree**（branch/rewind，见三节 Session 管理）
2. **EventStream 异步迭代器**（替代回调风格，见二节 Agent Loop）

---

## 二、Agent Loop 设计

### 2.1 设计目标

- TypeScript strict，ESM，与现有 Fastify server 无缝集成
- 工具调用循环（agentic loop）：LLM → tool calls → results → LLM，直到无工具调用或达到最大轮数
- 并行工具执行：同一轮的多个工具调用并行执行（参考 hermes `_should_parallelize_tool_batch`）
- 工具结果超限处理：大输出截断 + 持久化到磁盘，不撑爆 context
- **流式 API 用 AsyncIterable 而非回调**（借鉴 Pi EventStream 设计）

### 2.2 工具注册机制（借鉴 hermes）

Hermes 的工具注册是本项目最值得借鉴的设计：每个工具文件自注册，无中央清单，发现机制靠目录扫描。

```typescript
// src/tools/registry.ts
export interface ToolDefinition {
  name: string
  description: string
  schema: JSONSchema        // 参数 schema（JSON Schema）
  handler: ToolHandler      // 执行函数
  toolset?: string[]        // 分组标签（'core' | 'file' | 'web' | 'memory' | 'channel'）
  requiresApproval?: boolean // 危险操作需要用户确认
  executionMode?: 'sequential' | 'parallel'  // 借鉴 Pi，per-tool 覆盖全局并行策略
}

export type ToolHandler = (
  params: Record<string, unknown>,
  ctx: ToolContext
) => Promise<ToolResult>

export interface ToolContext {
  sessionId: string
  workdir: string
  logger: Logger
  config: GeminiClawConfig
  memory?: MemoryStrategy
}

export class ToolRegistry {
  register(def: ToolDefinition): void
  get(name: string): ToolDefinition | null
  list(toolset?: string): ToolDefinition[]
  static discover(toolsDir: string): Promise<ToolRegistry>
}
```

**每个工具文件的结构：**
```typescript
// src/tools/exec.ts
import { registry } from './registry.js'

registry.register({
  name: 'exec',
  description: 'Execute shell commands',
  schema: { /* JSON Schema */ },
  toolset: ['core'],
  requiresApproval: true,
  executionMode: 'sequential',  // exec 有副作用，不可并行
  handler: async (params, ctx) => { /* ... */ }
})
```

### 2.3 Agent Loop 核心（借鉴 Pi EventStream 风格）

```typescript
// src/agent/loop.ts

// 借鉴 Pi 的 AgentEvent 类型
export type AgentEvent =
  | { type: 'turn_start' }
  | { type: 'turn_end'; message: Message; toolResults: ToolResult[] }
  | { type: 'message_delta'; delta: string }
  | { type: 'tool_start'; toolCallId: string; toolName: string; args: unknown }
  | { type: 'tool_end'; toolCallId: string; toolName: string; result: ToolResult; isError: boolean }
  | { type: 'agent_end'; messages: Message[] }

export class AgentLoop {
  constructor(params: {
    providerRouter: ProviderRouter
    toolRegistry: ToolRegistry
    memory: MemoryStrategy
    config: AgentConfig
    logger: Logger
  })

  // 返回 AsyncIterable（借鉴 Pi EventStream，替代回调风格）
  run(params: {
    messages: Message[]
    sessionId: string
    branchId?: string     // Session Tree 支线 ID（见三节）
    model?: string
    signal?: AbortSignal
    // 借鉴 Pi 的钩子
    beforeToolCall?: (ctx: BeforeToolCallContext) => Promise<{ block?: boolean; reason?: string }>
    afterToolCall?: (ctx: AfterToolCallContext) => Promise<Partial<ToolResult> | undefined>
  }): AsyncIterable<AgentEvent>
}
```

**Loop 流程：**
```
1. 构造 messages（含 system prompt + 工具 schema）
2. 调用 LLM（streaming，yield message_delta 事件）
3. 如果响应有 tool_calls：
   a. yield turn_end 事件
   b. 对每个 tool_call，调 beforeToolCall 钩子（可 block）
   c. 检测可并行批次，执行工具（yield tool_start / tool_end 事件）
   d. 调 afterToolCall 钩子（可 override 结果）
   e. 把工具结果追加到 messages，回到步骤 1
4. 如果无 tool_calls 或达到 maxTurns（默认 10）：yield agent_end
```

**并行检测逻辑（参考 hermes）：**
```typescript
// 以下工具不可并行（有副作用或依赖顺序）
const SEQUENTIAL_TOOLS = new Set(['exec', 'write', 'edit', 'sessions_spawn'])

function shouldParallelize(toolCalls: ToolCall[]): boolean {
  if (toolCalls.length <= 1) return false
  return toolCalls.every(tc => !SEQUENTIAL_TOOLS.has(tc.name))
}
```

### 2.4 核心工具清单（Phase G 实现）

优先级基于实际使用频率（参考 OpenClaw 工具调用日志）：

**P0 — 必须有才能运作：**
| 工具 | 说明 | 参考 |
|------|------|------|
| `exec` | Shell 命令执行，PTY 支持，超时控制 | OpenClaw exec tool |
| `read` | 读文件，支持 offset/limit | OpenClaw read |
| `write` | 写文件（覆盖） | OpenClaw write |
| `edit` | 精确文本替换（oldText → newText） | OpenClaw edit |
| `web_fetch` | HTTP 抓取，HTML → markdown | OpenClaw web_fetch |
| `memory_search` | 语义搜索记忆（embedding） | OpenClaw memory_search |
| `memory_get` | 按路径读记忆文件 | OpenClaw memory_get |

**P1 — 核心体验：**
| 工具 | 说明 | 参考 |
|------|------|------|
| `cron` | 定时任务管理 | OpenClaw cron |
| `message` | 发送消息（QQBot/channel） | OpenClaw message |
| `sessions_spawn` | 派发子 Agent | OpenClaw sessions_spawn |
| `sessions_list` | 列出 sessions | OpenClaw sessions_list |
| `sessions_history` | 读取 session 历史 | OpenClaw sessions_history |

**P2 — 进阶：**
| 工具 | 说明 |
|------|------|
| `browser` | 浏览器控制（CDP） |
| `image` | 图片分析（vision） |
| `dir_list` / `dir_fetch` | 目录操作 |
| `nodes` | 配对节点控制 |

---

## 三、Session 管理设计（Session Tree + SQLite）

### 3.1 现状问题

- buffer 策略：纯内存，重启丢失
- layered 策略：topics SQLite，但 messages 没有持久化
- 没有跨 session 查询
- 没有 FTS 全文搜索
- **Session 是线性的**，无法支持 Evolution Engine 的隔离支线需求

### 3.2 Session Tree 设计（核心升级，借鉴 Pi）

Session 不再是平铺的列表，而是一棵树：

```
session-main-001（主线，用户对话）
├── session-main-001 / turn 1~N（正常对话）
└── session-evo-abc123（evolution branch，子节点）
    ├── Mutator 工具调用记录
    ├── Validator 输出
    └── 结果 summary（merge 回主线时注入）
```

**关键字段：**
- `parent_session_id`：指向父 session（NULL 表示根节点）
- `branch_type`：`'main' | 'evolution' | 'subagent' | 'compress'`
- `branch_summary`：支线结束时写入，父 session 可读取

这个设计同时解决了三个问题：
1. Evolution Engine 支线隔离（不污染主线 context）
2. Context 压缩历史追溯（compress 类型的子 session 保存压缩前快照）
3. 子 Agent 结果汇报（subagent 类型的子 session）

### 3.3 SQLite Schema（WAL + FTS5）

```sql
-- sessions 表（树形结构）
CREATE TABLE sessions (
  id                TEXT PRIMARY KEY,
  parent_session_id TEXT,                    -- NULL = 根节点
  branch_type       TEXT NOT NULL DEFAULT 'main',  -- 'main'|'evolution'|'subagent'|'compress'
  branch_summary    TEXT,                    -- 支线结束时写入，父节点可读
  source            TEXT NOT NULL,           -- 'http' | 'qqbot' | 'telegram' | 'cli'
  model             TEXT,
  started_at        INTEGER NOT NULL,
  ended_at          INTEGER,
  end_reason        TEXT,                    -- 'done' | 'compress' | 'branch_merged' | 'branch_aborted'
  message_count     INTEGER DEFAULT 0,
  input_tokens      INTEGER DEFAULT 0,
  output_tokens     INTEGER DEFAULT 0,
  title             TEXT,
  FOREIGN KEY (parent_session_id) REFERENCES sessions(id)
);

-- messages 表（全量历史）
CREATE TABLE messages (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id   TEXT NOT NULL REFERENCES sessions(id),
  role         TEXT NOT NULL,                -- 'user' | 'assistant' | 'tool'
  content      TEXT,
  tool_calls   TEXT,                         -- JSON
  tool_call_id TEXT,
  created_at   INTEGER NOT NULL
);

-- FTS5 全文搜索（借鉴 hermes，含 CJK trigram 支持）
CREATE VIRTUAL TABLE messages_fts USING fts5(
  content,
  content=messages,
  content_rowid=id,
  tokenize='unicode61 trigram'
);

CREATE TRIGGER messages_fts_insert AFTER INSERT ON messages
  BEGIN INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content); END;
CREATE TRIGGER messages_fts_delete AFTER DELETE ON messages
  BEGIN DELETE FROM messages_fts WHERE rowid = old.id; END;
```

### 3.4 SessionStore API

```typescript
// src/session/store.ts
export class SessionStore {
  // 创建根节点 session（用户对话）
  create(params: { source: string; model: string }): Session

  // 创建子 session（支线）
  branch(parentId: string, params: {
    branchType: 'evolution' | 'subagent' | 'compress'
    model?: string
  }): Session

  // 支线结束，写入 summary，通知父 session
  mergeBranch(branchId: string, summary: string): void
  abortBranch(branchId: string, reason: string): void

  // 追加消息（自动更新 FTS）
  appendMessage(sessionId: string, msg: Message): void

  // 读取 session 树（含子节点摘要）
  getTree(rootId: string): SessionTree

  // 全文搜索（跨所有 sessions）
  search(query: string, limit?: number): SearchResult[]

  // 按 sessionId 读取历史
  getHistory(sessionId: string, limit?: number): Message[]

  // 列出最近根节点 sessions
  listRecent(source?: string, limit?: number): Session[]
}
```

### 3.5 Evolution Engine 与 Session Tree 的集成

Evolution Engine 的 `runOnce()` 流程更新为：

```typescript
// 1. 从主线 session 创建 evolution 支线
const evoBranch = sessionStore.branch(mainSessionId, { branchType: 'evolution' })

// 2. Mutator 在支线 session 里记录工具调用
await mutator.run(intent, { sessionId: evoBranch.id })

// 3. 验证通过 → merge 支线，summary 注入主线
sessionStore.mergeBranch(evoBranch.id, `Evolution: ${intent.title} — ${result.summary}`)

// 4. 验证失败 → 废弃支线
sessionStore.abortBranch(evoBranch.id, result.reason)
```

---

## 四、QQBot 渠道（内嵌，不做 plugin）

### 4.1 设计决策

QQBot 是核心渠道，内嵌到主代码库，不做成可选 plugin。

参考：
- Hermes QQBot adapter（`gateway/platforms/qqbot/adapter.py`，2402 行）— 完整实现，含 C2C、群消息、媒体上传、webhook 验签
- OpenClaw QQBot extension（`extensions/qqbot/`，1581 行）— 与 OpenClaw session 系统耦合

**选择 hermes 实现作为主要参考**，TypeScript 翻译，因为：
- hermes 的 QQBot 解耦更好，不依赖特定运行时
- 2402 行 Python → 约 1200 行 TypeScript（类型系统压缩）

### 4.2 模块结构

```
src/channels/
├── index.ts          ← ChannelManager，管理所有 channel adapter
├── types.ts          ← ChannelAdapter interface
└── qqbot/
    ├── index.ts      ← QQBotChannel（实现 ChannelAdapter）
    ├── webhook.ts    ← Webhook 验签 + 消息路由
    ├── api.ts        ← QQ Open API 调用（发消息、上传媒体）
    ├── types.ts      ← QQ 消息类型定义
    └── crypto.ts     ← ED25519 验签
```

### 4.3 ChannelAdapter 接口

```typescript
// src/channels/types.ts
export interface ChannelAdapter {
  name: string

  // 初始化（注册 webhook 路由到 Fastify）
  init(server: FastifyInstance, agentLoop: AgentLoop): Promise<void>

  // 发送消息
  send(target: string, content: ChannelMessage): Promise<void>

  // 健康检查
  health(): Promise<{ ok: boolean; detail?: string }>
}

export type ChannelMessage = {
  text?: string
  media?: { url: string; type: 'image' | 'video' | 'audio' | 'file' }
  replyTo?: string
}
```

---

## 五、Plugin 系统设计（轻量，hermes 风格）

### 5.1 设计原则

**不做 OpenClaw 那套重 plugin 系统**（40+ `registerXxx` 方法，131 个 extensions，独立 SDK）。

采用 hermes 的**目录约定 + 接口约束**：
- 每类 plugin 一个目录
- 每个 plugin 一个子目录，含 `index.ts` 实现指定接口
- 发现：启动时扫描目录，动态 import
- 激活：config 驱动（memory provider 只激活一个，channel/tool bundle 可多个）

### 5.2 Plugin 类型

```
src/plugins/
├── memory/           ← 替换记忆策略（一次只激活一个）
│   └── <name>/
│       └── index.ts  ← 实现 MemoryStrategy interface
│
├── channels/         ← 追加渠道（可多个并行）
│   └── <name>/
│       └── index.ts  ← 实现 ChannelAdapter interface
│
└── tools/            ← 追加工具包（可多个并行）
    └── <name>/
        └── index.ts  ← 导出 ToolDefinition[]
```

### 5.3 Plugin 发现（约 60 行代码）

```typescript
// src/plugins/loader.ts
export async function discoverPlugins(config: GeminiClawConfig): Promise<LoadedPlugins> {
  const builtinDir = new URL('../plugins', import.meta.url).pathname
  const userDir = join(config.dataDir, 'plugins')

  return {
    memory: await loadMemoryPlugin(config.memory.provider, [builtinDir, userDir]),
    channels: await loadChannelPlugins(config.channels ?? [], [builtinDir, userDir]),
    tools: await loadToolPlugins(config.tools?.bundles ?? [], [builtinDir, userDir]),
  }
}
```

### 5.4 内嵌 vs Plugin 的边界

| 功能 | 内嵌 | Plugin |
|------|------|--------|
| Layered memory（SQLite 4层） | ✅ 内嵌 | — |
| Buffer memory（dev/test） | ✅ 内嵌 | — |
| QQBot channel | ✅ 内嵌 | — |
| Evolution Engine | ✅ 内嵌 | — |
| Telegram channel | — | ✅ plugin |
| Discord channel | — | ✅ plugin |
| mem0 / LanceDB memory | — | ✅ plugin |
| 自定义工具包 | — | ✅ plugin |

---

## 六、Control UI

### 6.1 短期方案：OpenAI 兼容层

在现有 `/v1/agent/chat` 之外，增加 `/v1/chat/completions`（OpenAI 兼容）端点。

这样可以直接接入：
- OpenClaw 的 WebChat UI（通过 `gateway.http.endpoints.chatCompletions.enabled: true`）
- 任何 OpenAI 兼容的前端（Open WebUI、LobeChat 等）

```typescript
// src/server/routes/completions.ts
// POST /v1/chat/completions
// 适配层：把 OpenAI 格式转成 GeminiClaw AgentLoop 调用，结果转回 OpenAI 格式
```

### 6.2 中期方案：轻量 Web UI

参考 hermes `web/` 目录（纯 HTML + Vanilla JS，无框架）：
- 单文件 `index.html`（~500 行）
- SSE 流式渲染（消费 AgentEvent AsyncIterable）
- session 树形切换（主线 + 支线可视化）
- 不依赖 React/Vue/任何构建工具

---

## 七、模型配置统一

把旧版 `~/.gemeniclaw/openclaw.json` 里的所有 provider 同步到新版 `config.yaml`：

```yaml
providers:
  - name: mcli
    type: mcli
    baseUrl: "https://mcli.sankuai.com"
    apiKey: "${MCLI_API_KEY}"
    extraHeaders:
      X-Working-Dir: "/Users/lipingjiang"
    models:
      - claude-opus-4-6
      - claude-sonnet-4-5
      - claude-haiku-4-5

  - name: friday
    type: friday
    baseUrl: "https:///v1/openai/native"
    apiKey: "${FRIDAY_API_KEY}"
    models:
      - gemini-3-flash-preview
      - gemini-3.1-pro-preview
      - gpt-4.1
      - deepseek-v3.2-meituan
      - kimi-k2.5
      - MiniMax-M2.5
      - MiniMax-M2.7
      - LongCat-Flash-Omni
      - o4-mini-2025-04-16
      - LongCat-Flash-Thinking-2601
      - aws.claude-sonnet-4.5
      - glm-4.5-flash

  - name: longcat
    type: openai-compat
    baseUrl: "https://api.longcat.chat/openai"
    apiKey: "${LONGCAT_API_KEY}"
    models:
      - longcat-flash-chat

routing:
  default: "mcli/claude-opus-4-6"
  fallback:
    - "mcli/claude-sonnet-4-5"
    - "friday/gemini-3-flash-preview"
```

---

## 八、实施路线（接续 Evolution Engine）

Evolution Engine 路线（Phase A-E）不变，Runtime 能力补齐作为并行 Phase F-I：

### Phase F：Session Tree 升级（1-2天）
- [ ] `src/session/store.ts` — SQLite WAL + FTS5 + **Session Tree**（branch/mergeBranch/abortBranch）
- [ ] 迁移现有 buffer/layered 策略使用 SessionStore
- [ ] `/v1/sessions` + `/v1/sessions/search` HTTP API
- [ ] Evolution Engine 集成 Session Tree（evoBranch 隔离）

### Phase G：Agent Loop + 核心工具（3-5天）
- [ ] `src/tools/registry.ts` — ToolRegistry（hermes 风格自注册，含 executionMode）
- [ ] `src/agent/loop.ts` — AgentLoop（**AsyncIterable EventStream**，借鉴 Pi；**beforeToolCall/afterToolCall 钩子**）
- [ ] P0 工具：exec、read、write、edit、web_fetch、memory_search、memory_get
- [ ] P1 工具：cron、message、sessions_spawn、sessions_list、sessions_history
- [ ] chat route 升级：接入 AgentLoop（替换直接调 providerRouter）

### Phase H：QQBot + Control UI（2-3天）
- [ ] `src/channels/qqbot/` — QQBot channel（移植 hermes adapter）
- [ ] `src/channels/index.ts` — ChannelManager
- [ ] `/v1/chat/completions` — OpenAI 兼容层
- [ ] 轻量 Web UI（单文件 HTML，含 Session Tree 可视化）

### Phase I：Plugin 系统（1-2天）
- [ ] `src/plugins/loader.ts` — 目录扫描 + 动态 import
- [ ] Memory plugin 接口
- [ ] Channel plugin 接口
- [ ] Tool bundle plugin 接口

---

## 九、README 对比表（三列）

| 能力 | OpenClaw | Hermes | **GeminiClaw** |
|------|----------|--------|----------------|
| Agent loop | ✅ TypeScript（Pi 框架） | ✅ Python（自研） | 🔜 TypeScript（自实现，Phase G） |
| Session 结构 | ✅ 线性 | ✅ 线性 | ✅ **树形**（branch/rewind，Phase F） |
| 内置工具数量 | 30+ | 69 | 🔜 7→20+（Phase G） |
| Multi-channel | ✅ 20+ | ✅ Telegram/Discord/Slack/WhatsApp/Signal | ✅ QQBot（Phase H）+ plugin |
| Plugin 系统 | ✅ 重（40+ API） | ✅ 轻（目录约定） | ✅ 轻（hermes 风格，Phase I） |
| Session 持久化 | ✅ JSONL（有损坏风险） | ✅ SQLite WAL | ✅ SQLite WAL（Phase F） |
| 跨 session 搜索 | ❌ | ✅ FTS5 + CJK trigram | ✅ FTS5（Phase F） |
| 分层记忆 | ❌ | ❌（flat curator） | ✅ L0-L3 topics |
| Self-evolution | ❌ | ❌ | ✅ Twin-System |
| Control UI | ✅ React SPA | ✅ TUI + Web | 🔜 OpenAI 兼容层（Phase H） |
| 语言 | TypeScript | Python | TypeScript |
| 代码量（核心） | ~数万行 | ~2万行 | ~5千行（目标） |
| 零 vendor lock-in | ⚠️（依赖 Pi 包） | ✅ | ✅ |

---

## 十、开放问题（已决策）

| # | 问题 | 决策 |
|---|------|------|
| 1 | Agent Loop 语言 | **TypeScript**，与现有代码库统一 |
| 2 | Agent 框架依赖 | **自实现**，不依赖 Pi 包；但移植 Pi 的 EventStream + Session Tree 设计 |
| 3 | Session 结构 | **树形**（branch/rewind），借鉴 Pi；Evolution Engine 支线完全隔离 |
| 4 | QQBot：内嵌 vs plugin | **内嵌**，核心渠道，不做成可选 |
| 5 | Plugin 系统风格 | **hermes 轻量风格**，目录约定 + 接口约束 |
| 6 | Session 存储 | **SQLite WAL**，借鉴 hermes schema，加 FTS5 + branch_type |
| 7 | Control UI 短期方案 | **OpenAI 兼容层**，复用现有前端 |
| 8 | 工具注册机制 | **hermes 自注册风格**，每个工具文件 `registry.register()`，加 `executionMode` 字段 |
| 9 | 旧版替换时机 | Phase G 完成（Agent Loop 跑通）后才考虑替换 |
