# 实现计划：Agent Modes

> **关联设计文档：** `docs/AGENT-MODES-DESIGN.md`
> **日期：** 2026-05-06
> **状态：** 待执行

---

## 阶段一：P0 — interrupt point 基础设施

**目标：** AgentLoop 支持暂停/恢复，Plan 和高置信度模式的共同前置。

### 1.1 `src/agent/types.ts`

新增类型：

```typescript
// 模式类型
export type AgentMode = 'auto' | 'step' | 'plan' | 'high-confidence'

// AgentConfig 新增字段
export interface AgentConfig {
  maxTurns?: number
  toolExecutionMode?: 'parallel' | 'sequential'
  maxToolOutputChars?: number
  systemPrompt?: string
  // 新增：
  mode?: AgentMode
  maxToolCallsPerTurn?: number          // step 模式
  guardrails?: GuardrailConfig          // tool_guardrails
  planning?: PlanningConfig             // plan 模式
  uncertaintyCheck?: UncertaintyConfig  // high-confidence 模式
}

// interrupt point
export interface PausePayload {
  kind: 'plan_ready' | 'uncertainty_check'
  data: unknown
}

// guardrails
export interface GuardrailConfig {
  sameToolFailureWarnAfter?: number   // 默认 3
  sameToolFailureHaltAfter?: number   // 默认 8
  noProgressWarnAfter?: number        // 默认 2
  noProgressHaltAfter?: number        // 默认 5
}

// planning
export interface PlanStep {
  id: string
  description: string
  toolHint?: string
  status: 'pending' | 'in_progress' | 'done' | 'failed'
}
export interface PlanningConfig {
  enabled: boolean
}

// uncertainty check
export interface UncertaintyItem {
  id: string
  question: string
  impact: 'blocking' | 'optional'
  resolved: boolean
  answer?: string
}
export interface UncertaintyConfig {
  enabled: boolean
  maxRounds?: number   // 默认 2
}

// 新增 AgentEvent
// 在现有 AgentEvent union 末尾追加：
| { type: 'paused'; pauseId: string; payload: PausePayload }
| { type: 'guardrail_warn'; message: string }
| { type: 'guardrail_halt'; message: string }
```

### 1.2 `src/agent/loop.ts`

新增 interrupt point 机制：

```typescript
// AgentLoop 新增私有状态
private pauseResolve: ((input: unknown) => void) | null = null

// 新增方法
resume(pauseId: string, userInput: unknown): void {
  if (this.pauseResolve) {
    this.pauseResolve(userInput)
    this.pauseResolve = null
  }
}

// 新增私有方法
private async pause(payload: PausePayload): Promise<unknown> {
  const pauseId = randomUUID()
  yield { type: 'paused', pauseId, payload }  // 注意：loop.run() 是 generator，需要调整
  return new Promise(resolve => { this.pauseResolve = resolve })
}
```

> 注：`run()` 目前是 `AsyncGenerator`，pause 需要在 generator 内部 await 一个外部 resolve 的 Promise。
> 实现方式：在 `run()` 里 `yield { type: 'paused', ... }` 后紧接 `await this.waitForResume()`，
> `waitForResume()` 返回一个 Promise，由 `resume()` 调用 resolve。

### 1.3 `src/server/routes/chat.ts`

新增 resume 路由（或复用 chat 路由）：

```
POST /v1/agent/resume   { sessionId, pauseId, input }
GET  /v1/agent/status   → { state: 'running' | 'paused' | 'idle', pauseId? }
```

在 SessionStore 或内存 Map 中存储活跃的 AgentLoop 实例，供 resume 调用。

---

## 阶段二：P1 — Step 模式 + 模式切换

**目标：** Step 模式可用，session 级别模式切换生效。可以并行做，不互相依赖。

### 2.1 Step 模式（`src/agent/loop.ts`）

```typescript
// run() 内工具执行前截断
const allToolCalls = response.tool_calls ?? []
const toolCallsToRun = this.config.maxToolCallsPerTurn
  ? allToolCalls.slice(0, this.config.maxToolCallsPerTurn)
  : allToolCalls

// tool_guardrails（新增 GuardrailController 类）
// src/agent/guardrails.ts
```

**GuardrailController 逻辑（参考 Hermes `tool_guardrails.py`）：**
- 记录每个工具的连续失败次数
- 记录"无进展"轮数（连续调同一工具且都失败）
- 达到 warn 阈值 → yield `guardrail_warn` 事件（注入警告到 tool result）
- 达到 halt 阈值 → yield `guardrail_halt` 事件，停止循环

### 2.2 模式切换

**`src/session/store.ts`：** 新增 `session_meta` 表（key-value 存储，per session）

```sql
CREATE TABLE IF NOT EXISTS session_meta (
  session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  key         TEXT NOT NULL,
  value       TEXT NOT NULL,
  PRIMARY KEY (session_id, key)
)
```

新增方法：
```typescript
getMeta(sessionId: string, key: string): string | null
setMeta(sessionId: string, key: string, value: string): void
```

**`src/server/routes/chat.ts`：** 读取 session mode 并注入 AgentConfig：
```typescript
const mode = (sessionStore.getMeta(sessionId, 'agent_mode') ?? 'auto') as AgentMode
const agentConfig = buildAgentConfig(mode, requestBody.mode)
```

**新增 `/mode` 命令处理（`src/server/routes/chat.ts` 或单独 handler）：**
```
/mode           → 返回当前模式
/mode <name>    → 设置模式，返回确认
```

**`src/channels/qqbot/index.ts`：** 在消息处理前检测 `/mode` 命令，拦截并处理，不走 agent。

---

## 阶段三：P2 — Plan 模式

**目标：** agent 先输出 plan，用户确认后再执行。依赖阶段一的 interrupt point。

### 3.1 Plan 模式 system prompt 注入

当 `mode === 'plan'` 时，在 system prompt 末尾注入：

```
当你收到一个需要多步执行的任务时，请先输出一个结构化的执行计划，格式如下：
<plan>
[{"id":"1","description":"...","toolHint":"read_file"},...]
</plan>
在计划被用户确认之前，不要调用任何工具。
```

### 3.2 AgentLoop 解析 plan 并暂停

在 `run()` 的 message_delta 处理里，检测 `<plan>...</plan>` 标签：
- 解析出 PlanStep[]
- 调用 `pause({ kind: 'plan_ready', data: { plan } })`
- 等待 resume，用户可以修改/确认 plan
- resume 后继续执行（把确认的 plan 注入上下文）

### 3.3 前端（one-portal）

收到 `paused` 事件且 `payload.kind === 'plan_ready'` 时：
- 渲染 plan 列表（每步可见）
- 显示"确认执行"按钮
- 点击后调 `POST /v1/agent/resume`

---

## 阶段四：P3 — 高置信度模式

**目标：** 执行行动工具前必须先消除不确定性。依赖阶段一的 interrupt point。

### 4.1 clarify_uncertainty tool

新增 `src/tools/clarify_uncertainty.ts`：
- agent 调用此工具列出不确定点
- tool result 返回"等待用户回答"
- AgentLoop 检测到此工具调用 → 触发 pause

### 4.2 beforeToolCall hook 物理拦截

在 `src/agent/loop.ts` 的工具执行前：
```typescript
if (config.uncertaintyCheck?.enabled && isMutatingTool(tc.name)) {
  const cleared = sessionStore.getMeta(sessionId, 'uncertainty_cleared')
  if (cleared !== 'true') {
    // 物理阻止，返回 block 结果
    return { content: '[blocked] Must resolve uncertainties first', isError: true }
  }
}
```

**mutating tools 列表（实现时定，暂定方案 A 硬编码）：**
`exec`, `write`, `edit`, `file_write`

### 4.3 前端（one-portal）

收到 `paused` 事件且 `payload.kind === 'uncertainty_check'` 时：
- 渲染不确定点列表（每项有输入框）
- 用户填写答案后提交
- 调 `POST /v1/agent/resume`，携带答案

---

## 前端工作（one-portal，与后端并行）

**模式切换 UI（配合阶段二）：**
- 输入框左下角加模式标签（`Auto ▾`）
- 点击弹出菜单：Auto / Step / Plan / 高置信度
- 选中后调 `POST /v1/agent/mode { mode }` 或在下一条消息里带 `mode` 字段
- 本地 state 同步显示

**Plan 确认 UI（配合阶段三）：**
- SSE 收到 `paused + plan_ready` → 渲染 plan 卡片
- 确认/取消按钮

**Uncertainty UI（配合阶段四）：**
- SSE 收到 `paused + uncertainty_check` → 渲染问题列表
- 逐项填写，提交

---

## 文件改动清单

| 文件 | 改动 | 阶段 |
|------|------|------|
| `src/agent/types.ts` | 新增 AgentMode、AgentConfig 扩展、PausePayload、GuardrailConfig 等 | P0 |
| `src/agent/loop.ts` | pause/resume 机制、maxToolCallsPerTurn 截断、guardrails 集成、plan 解析、beforeToolCall hook | P0/P1/P2/P3 |
| `src/agent/guardrails.ts` | 新建 GuardrailController | P1 |
| `src/session/store.ts` | 新增 session_meta 表 + getMeta/setMeta | P1 |
| `src/server/routes/chat.ts` | mode 读取注入、/mode 命令处理、resume 路由 | P0/P1 |
| `src/channels/qqbot/index.ts` | /mode 命令拦截 | P1 |
| `src/tools/clarify_uncertainty.ts` | 新建 clarify_uncertainty tool | P3 |
| `src/tools/index.ts` | 注册 clarify_uncertainty | P3 |
| one-portal 前端 | 模式切换 UI、Plan 确认 UI、Uncertainty UI | P1/P2/P3 |

---

## 测试要点

- [ ] Step 模式：每 turn 只执行 1 个工具调用
- [ ] GuardrailController：相同工具连续失败达到阈值时正确 halt
- [ ] 模式切换：session 内持久化，重启不丢失
- [ ] /mode 命令：QQ Bot / Web UI 均可切换
- [ ] interrupt point：pause 后 SSE 不断开，resume 后继续执行
- [ ] Plan 模式：planning phase 不调工具，确认后正常执行
- [ ] 高置信度模式：未 cleared 时 mutating tool 被物理拦截
