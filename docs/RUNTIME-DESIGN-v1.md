# GeminiClaw Runtime Design v1

> **状态：** 设计稿
> **作者：** 李平江 + 观澜
> **日期：** 2026-05-05
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

**核心原则：借鉴 hermes 的轻量设计哲学，不照搬 OpenClaw 的重 plugin 系统。**

---

## 二、Agent Loop 设计

### 2.1 设计目标

- TypeScript strict，ESM，与现有 Fastify server 无缝集成
- 工具调用循环（agentic loop）：LLM → tool calls → results → LLM，直到无工具调用或达到最大轮数
- 并行工具执行：同一轮的多个工具调用并行执行（参考 hermes `_should_parallelize_tool_batch`）
- 工具结果超限处理：大输出截断 + 持久化到磁盘，不撑爆 context

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
  // 允许工具访问记忆系统
  memory?: MemoryStrategy
}

export class ToolRegistry {
  register(def: ToolDefinition): void
  get(name: string): ToolDefinition | null
  list(toolset?: string): ToolDefinition[]
  // 扫描 src/tools/ 目录，import 有 registry.register() 调用的文件
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
  handler: async (params, ctx) => { /* ... */ }
})
```

### 2.3 Agent Loop 核心

```typescript
// src/agent/loop.ts
export class AgentLoop {
  constructor(params: {
    providerRouter: ProviderRouter
    toolRegistry: ToolRegistry
    memory: MemoryStrategy
    config: AgentConfig
    logger: Logger
  })

  // 单次对话轮次（含工具调用循环）
  async run(params: {
    messages: Message[]
    sessionId: string
    model?: string
    stream?: boolean
    onDelta?: (delta: string) => void      // 流式回调
    onToolCall?: (call: ToolCall) => void  // 工具调用通知
  }): Promise<AgentResult>
}

type AgentResult = {
  message: string
  toolCallCount: number
  inputTokens: number
  outputTokens: number
  model: string
}
```

**Loop 流程：**
```
1. 构造 messages（含 system prompt + 工具 schema）
2. 调用 LLM（streaming 或 non-streaming）
3. 如果响应有 tool_calls：
   a. 检测可并行的工具批次（无依赖关系 → 并行，有依赖 → 串行）
   b. 执行工具（Promise.all 并行 / 串行）
   c. 把工具结果追加到 messages
   d. 回到步骤 2
4. 如果无 tool_calls 或达到 maxTurns（默认 10）：返回最终响应
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

### 2.4 核心工具清单（Phase E 实现）

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

## 三、Session 管理设计（升级）

### 3.1 现状问题

- buffer 策略：纯内存，重启丢失
- layered 策略：topics SQLite，但 messages 没有持久化
- 没有跨 session 查询
- 没有 FTS 全文搜索

### 3.2 目标设计（借鉴 hermes `hermes_state.py`）

**统一 SQLite 存储（WAL 模式）：**

```sql
-- sessions 表
CREATE TABLE sessions (
  id          TEXT PRIMARY KEY,
  source      TEXT NOT NULL,           -- 'http' | 'qqbot' | 'telegram' | 'cli'
  model       TEXT,
  parent_session_id TEXT,              -- 压缩后的前驱 session
  started_at  INTEGER NOT NULL,
  ended_at    INTEGER,
  end_reason  TEXT,                    -- 'reset' | 'compress' | 'timeout'
  message_count INTEGER DEFAULT 0,
  input_tokens  INTEGER DEFAULT 0,
  output_tokens INTEGER DEFAULT 0,
  title       TEXT,                    -- LLM 自动生成的标题
  FOREIGN KEY (parent_session_id) REFERENCES sessions(id)
);

-- messages 表（全量历史）
CREATE TABLE messages (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  TEXT NOT NULL REFERENCES sessions(id),
  role        TEXT NOT NULL,           -- 'user' | 'assistant' | 'tool'
  content     TEXT,
  tool_calls  TEXT,                    -- JSON
  tool_call_id TEXT,
  created_at  INTEGER NOT NULL
);

-- FTS5 全文搜索（借鉴 hermes，含 CJK trigram 支持）
CREATE VIRTUAL TABLE messages_fts USING fts5(
  content,
  content=messages,
  content_rowid=id,
  tokenize='unicode61 trigram'         -- trigram 支持中文子串搜索
);

-- 触发器自动维护 FTS 索引
CREATE TRIGGER messages_fts_insert AFTER INSERT ON messages
  BEGIN INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content); END;
CREATE TRIGGER messages_fts_delete AFTER DELETE ON messages
  BEGIN DELETE FROM messages_fts WHERE rowid = old.id; END;
```

### 3.3 Session 生命周期

```typescript
// src/session/store.ts
export class SessionStore {
  // 创建新 session
  create(params: { source: string; model: string }): Session

  // 追加消息（自动更新 FTS）
  appendMessage(sessionId: string, msg: Message): void

  // 压缩：当前 session 结束，新建子 session
  compress(sessionId: string, summary: string): Session

  // 全文搜索（跨所有 sessions）
  search(query: string, limit?: number): SearchResult[]

  // 按 sessionId 读取历史
  getHistory(sessionId: string, limit?: number): Message[]

  // 列出最近 sessions
  listRecent(source?: string, limit?: number): Session[]
}
```

### 3.4 压缩策略（parent_session_id 链）

当 context 接近 token 上限时：
1. 调用 LLM 生成当前 session 的摘要
2. 把摘要作为第一条 system message 写入新 session
3. 新 session 的 `parent_session_id` 指向旧 session
4. 旧 session 标记 `end_reason: 'compress'`

这样历史永不丢失，可以通过 `parent_session_id` 链追溯全部历史。

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

**用户安装 plugin：**
```bash
# 把 plugin 目录放到 ~/.gemini-data/plugins/<type>/<name>/
# 启动时自动发现，无需重启（热加载，TODO Phase G）
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
- SSE 流式渲染
- session 切换
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

### Phase F：Session 管理升级（1-2天）
- [ ] `src/session/store.ts` — SQLite WAL + FTS5 + parent_session_id
- [ ] 迁移现有 buffer/layered 策略使用 SessionStore
- [ ] `/v1/sessions` + `/v1/sessions/search` HTTP API
- [ ] session 压缩时 parent_session_id 链接

### Phase G：Agent Loop + 核心工具（3-5天）
- [ ] `src/tools/registry.ts` — ToolRegistry（hermes 风格自注册）
- [ ] `src/agent/loop.ts` — AgentLoop（工具调用循环，并行执行）
- [ ] P0 工具：exec、read、write、edit、web_fetch、memory_search、memory_get
- [ ] P1 工具：cron、message、sessions_spawn、sessions_list、sessions_history
- [ ] chat route 升级：接入 AgentLoop（替换直接调 providerRouter）

### Phase H：QQBot + Control UI（2-3天）
- [ ] `src/channels/qqbot/` — QQBot channel（移植 hermes adapter）
- [ ] `src/channels/index.ts` — ChannelManager
- [ ] `/v1/chat/completions` — OpenAI 兼容层
- [ ] 轻量 Web UI（单文件 HTML）

### Phase I：Plugin 系统（1-2天）
- [ ] `src/plugins/loader.ts` — 目录扫描 + 动态 import
- [ ] Memory plugin 接口
- [ ] Channel plugin 接口
- [ ] Tool bundle plugin 接口

---

## 九、README 对比表更新

README 的对比表从两列（OpenClaw vs GeminiClaw）改为三列，加入 Hermes：

| 能力 | OpenClaw | Hermes | **GeminiClaw** |
|------|----------|--------|----------------|
| Agent loop | ✅ TypeScript | ✅ Python | 🔜 Phase G |
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
| 零 vendor lock-in | ⚠️ | ✅ | ✅ |

---

## 十、开放问题（已决策）

| # | 问题 | 决策 |
|---|------|------|
| 1 | Agent Loop 语言 | **TypeScript**，与现有代码库统一 |
| 2 | QQBot：内嵌 vs plugin | **内嵌**，核心渠道，不做成可选 |
| 3 | Plugin 系统风格 | **hermes 轻量风格**，目录约定 + ABC 接口 |
| 4 | Session 存储 | **SQLite WAL**，借鉴 hermes schema，加 FTS5 |
| 5 | Control UI 短期方案 | **OpenAI 兼容层**，复用现有前端 |
| 6 | 工具注册机制 | **hermes 自注册风格**，每个工具文件 `registry.register()` |
| 7 | 旧版替换时机 | Phase G 完成（Agent Loop 跑通）后才考虑替换 |
