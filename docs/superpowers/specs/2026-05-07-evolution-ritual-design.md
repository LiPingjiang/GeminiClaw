# Evolution Ritual Design

**Date:** 2026-05-07  
**Status:** Approved  
**Scope:** GeminiClaw Evolution Engine — User-controlled evolution ceremony

---

## 1. Problem Statement

当前 Evolution Engine 存在一个核心问题：`riskLevel=low` 的 intent 会在用户聊天过程中**静默自动应用**，修改 Agent 行为，导致用户困惑。

根本矛盾：进化是元操作（修改 Agent 本身），不应在用户使用过程中悄悄发生。

---

## 2. Design Goals

1. **聊天过程中静默**：Evolution Engine 只收集、分析、预生成，不自动应用任何变更
2. **用户主动触发进化仪式**：用户说"进化"时，列出候选优化项（编号清单）
3. **效果对比可见**：用户选择某项后，展示同一问题的 before/after 对话对比
4. **用户最终确认**：用户明确说"确认"后才落地，任何风险级别都不例外
5. **双入口**：聊天（对话流）+ Dashboard（Web UI）均支持

---

## 3. Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                      Chat Route                             │
│  每轮对话结束后：                                            │
│  1. TraceCollector.record() — 统计元数据                    │
│  2. ConversationStore.save() — 存 userMessage + agentReply  │
│  3. IntentClassifier.classify() — 检测是否触发进化仪式       │
└─────────────────────┬───────────────────────────────────────┘
                      │ 触发进化仪式
                      ▼
┌─────────────────────────────────────────────────────────────┐
│                  Evolution Ritual Handler                   │
│  listCandidates() → 列出待审批 intent（带摘要+风险级别）     │
│  showPreview(intentId) → 取 PreviewService 预生成的对比      │
│  confirm(intentId) → 调 approveIntent() 落地                │
└─────────────────────┬───────────────────────────────────────┘
                      │
         ┌────────────┴────────────┐
         ▼                         ▼
┌────────────────┐       ┌──────────────────────┐
│ PreviewService │       │  Evolution Engine     │
│ (后台预生成)   │       │  (Mutator/Validator)  │
│                │       │                       │
│ Mutator 完成后 │       │  所有 intent 统一走   │
│ 自动挑选 trace │       │  pendingReview，不再  │
│ 重跑，存快照   │       │  自动 switch          │
└────────────────┘       └──────────────────────┘
```

---

## 4. Components

### 4.1 ConversationStore（新增）

**职责**：存储每轮对话的实际内容，供 PreviewService 重跑使用。

**数据表** `conversation_samples`：

```sql
CREATE TABLE conversation_samples (
  id          TEXT PRIMARY KEY,
  session_id  TEXT NOT NULL,
  trace_id    TEXT,                    -- 关联 traces 表
  user_message TEXT NOT NULL,          -- 用户原始输入
  agent_reply  TEXT NOT NULL,          -- Agent 当时的实际回复
  tool_sequence TEXT,                  -- JSON array，工具调用序列（冗余，方便检索）
  had_failure  INTEGER DEFAULT 0,
  recorded_at  INTEGER NOT NULL
);
CREATE INDEX idx_samples_session ON conversation_samples(session_id);
CREATE INDEX idx_samples_recorded ON conversation_samples(recorded_at DESC);
```

**写入时机**：chat route 每轮对话结束后，与 TraceCollector 同步调用。

**保留策略**：最近 500 条，超出按 `recorded_at` 淘汰（防止无限增长）。

---

### 4.2 PreviewService（新增）

**职责**：Mutator 完成变更后，异步预生成 before/after 对比快照。

**选 trace 策略**（相关性优先）：
1. 从 `conversation_samples` 里找与 intent `description` 语义最相关的样本
2. 优先选 `had_failure=true` 的（进化对错误场景的改善最直观）
3. 兜底取最近 2 条
4. 最多选 3 条

**生成流程**：
```
for each selected sample:
  before = sample.agent_reply  // 直接取历史回复
  after  = run LLM with new system prompt/config + sample.user_message
  summary = LLM one-liner: "本次优化做了什么"
  store → evolution_previews
```

**数据表** `evolution_previews`：

```sql
CREATE TABLE evolution_previews (
  id           TEXT PRIMARY KEY,
  intent_id    TEXT NOT NULL,
  sample_id    TEXT NOT NULL,           -- 关联 conversation_samples
  user_message TEXT NOT NULL,
  before_reply TEXT NOT NULL,
  after_reply  TEXT NOT NULL,
  summary      TEXT NOT NULL,           -- LLM 生成的一句话摘要
  generated_at INTEGER NOT NULL
);
CREATE INDEX idx_previews_intent ON evolution_previews(intent_id);
```

**触发时机**：`EvolutionEngine.runOnce()` 中 Mutator 成功、Validator 通过后，异步触发（不阻塞主流程）。

---

### 4.3 IntentClassifier（新增）

**职责**：识别用户消息是否触发进化仪式，使用 LLM 轻量分类。

**实现**：

```typescript
// 单独调一次 LLM，system prompt 极简，输出 JSON
const prompt = `
Classify the user's intent. Reply with JSON only.
{"intent": "evolve" | "evolve_show" | "evolve_confirm" | "evolve_reject" | "chat"}

Rules:
- "evolve": user wants to see improvement candidates ("进化", "evolve", "show improvements", "有什么可以优化的")
- "evolve_show": user wants to see a specific candidate's preview ("看第2个", "show me #3", "第一个的效果")
- "evolve_confirm": user confirms applying a change ("确认", "apply", "好的就这个", "confirm")
- "evolve_reject": user rejects ("不要", "skip", "跳过", "cancel")
- "chat": everything else

User message: "${userMessage}"
`
```

**分类结果**：
- `evolve` → 调 `listCandidates()`
- `evolve_show` + 序号 → 调 `showPreview(intentId)`
- `evolve_confirm` → 调 `confirmApply(intentId)`
- `evolve_reject` → 调 `rejectIntent(intentId)`
- `chat` → 走正常对话流

**状态管理**：进化仪式是有状态的（用户选了第几个），状态存在 session 级别的内存 Map 里（`evolutionSessionState`），key = sessionId。

---

### 4.4 Evolution Ritual Handler（新增）

**职责**：串联进化仪式的各个步骤，生成用户可读的聊天回复。

**listCandidates()**：
```
从 pending_reviews 取所有待审批 intent
按 riskLevel 排序（medium → high → low，最有价值的先展示）
格式化为编号清单：
  1. [🟠 中] 优化工具调用失败时的重试逻辑（影响文件：agent/loop.ts）
  2. [🔴 高] 重构上下文压缩策略（影响文件：agent/context.ts）
  3. [🟡 低] 调整默认回复长度阈值（影响文件：config/defaults.ts）
  
  说"看第N个"查看效果对比，说"跳过"退出。
```

**showPreview(intentId)**：
```
取 evolution_previews（该 intent 的快照）
如果预生成未完成 → 返回"正在生成对比，请稍后再试"
否则展示：
  📊 优化效果预览 — [intent 描述]
  
  示例问题：[user_message]
  
  ▌ 当前回答
  [before_reply]
  
  ▌ 优化后回答  
  [after_reply]
  
  摘要：[summary]
  
  说"确认"应用这个优化，说"跳过"查看下一个。
```

**confirmApply(intentId)**：
```
调 evolution.approveIntent(intentId, "user-chat")
清理 evolutionSessionState
返回确认消息 + 应用结果
```

---

### 4.5 修改现有逻辑：关闭自动 switch

**`EvolutionEngine.runOnce()`** 中，移除 `riskLevel=low` 的自动 switch 分支：

```typescript
// 原来：low risk → 自动 switch
// 改为：所有 intent 统一走 pendingReview，等用户确认
this.db.insertPendingReview({ ... requiresHumanApproval: true ... })
return { intentId, needsApproval: true, ... }
```

---

## 5. Dashboard API（扩展）

在现有 `/v1/evolution/*` 基础上新增：

| Method | Path | 说明 |
|--------|------|------|
| GET | `/v1/evolution/candidates` | 列出所有待审批 intent（带摘要、风险级别） |
| GET | `/v1/evolution/previews/:intentId` | 取某个 intent 的 before/after 快照列表 |
| POST | `/v1/evolution/reject/:id` | 拒绝某个 intent |

Dashboard 前端（已有的 Web UI）新增"进化中心"页面：
- 候选列表卡片（编号 + 摘要 + 风险徽章）
- 点击卡片展开 before/after 对比（摘要默认展示，diff 可折叠展开）
- 确认 / 拒绝按钮

---

## 6. Data Flow（完整链路）

```
[用户聊天]
  → chat route 处理请求
  → 生成回复
  → ConversationStore.save(userMsg, agentReply)   ← 新增
  → TraceCollector.record(统计元数据)
  → IntentClassifier.classify(userMsg)             ← 新增
    → "chat" → 正常返回
    → "evolve" → RitualHandler.listCandidates()

[后台 idle loop]
  → IntentEngine.generateIntents()
  → Mutator.mutate()
  → Validator.validate()
  → 所有 intent → insertPendingReview()            ← 修改（移除自动 switch）
  → PreviewService.generate(intentId)              ← 新增（异步）
    → 选 3 条 conversation_samples
    → 重跑 LLM → 存 evolution_previews

[用户触发进化仪式]
  → "进化" → listCandidates() → 展示编号清单
  → "看第2个" → showPreview(intentId) → 展示 before/after
  → "确认" → approveIntent() → manualSwitch() → 落地
```

---

## 7. Risk & Constraints

| 风险 | 缓解方案 |
|------|---------|
| PreviewService 重跑 LLM 有成本 | 每个 intent 最多 3 条样本，且异步，不影响主流程 |
| IntentClassifier 多一次 LLM 调用 | 极轻量（输入极短，JSON only 输出），延迟 <200ms |
| 进化仪式状态丢失（session 重启） | 状态只在内存，重启后用户重新说"进化"即可，无持久化需求 |
| conversation_samples 无限增长 | 保留最近 500 条，写入时自动淘汰 |
| preview 未生成完用户就来查 | 返回友好提示"正在生成，稍后再试"，前端轮询或用户手动刷新 |

---

## 8. Out of Scope

- 用户自选对比 trace（用户指定"用这个问题来对比"）
- 多个 intent 批量确认
- 进化历史回滚 UI（已有 circuit breaker 兜底）
- 移动端适配

---

## 9. File Change Summary

| 文件 | 变更类型 | 说明 |
|------|---------|------|
| `src/evolution/conversation-store.ts` | 新增 | ConversationStore 类 |
| `src/evolution/preview-service.ts` | 新增 | PreviewService 类 |
| `src/evolution/intent-classifier.ts` | 新增 | IntentClassifier 类（LLM 意图分类） |
| `src/evolution/ritual-handler.ts` | 新增 | Evolution Ritual Handler |
| `src/evolution/db.ts` | 修改 | 新增 conversation_samples、evolution_previews 表 |
| `src/evolution/types.ts` | 修改 | 新增 ConversationSample、EvolutionPreview 类型 |
| `src/evolution/index.ts` | 修改 | 移除自动 switch；集成 PreviewService；暴露 RitualHandler |
| `src/server/routes/chat.ts` | 修改 | 集成 ConversationStore + IntentClassifier；进化仪式分支 |
| `src/server/routes/evolution.ts` | 修改 | 新增 candidates、previews、reject 端点 |
