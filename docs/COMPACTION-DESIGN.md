# GeminiClaw Compaction 设计文档

> 状态：设计阶段，待实现  
> 作者：观澜  
> 日期：2026-05-23

---

## 背景

GeminiClaw 当前使用 `BufferStrategy`：内存滑动窗口，保留最近 20 条消息（10 轮对话），超出部分直接丢弃，无摘要，进程重启全丢。

对于 QQBot 这类长期对话场景，窗口截断会导致上下文断裂——模型"忘记"用户说过的事情，体验差。

---

## 设计目标

1. **context 不丢**：超出窗口的对话通过 LLM 摘要压缩保留
2. **对现有组件透明**：AgentLoop、ChannelContext 无需感知 compaction
3. **可配置压缩模型**：支持用更便宜的模型做摘要，降低成本
4. **渐进增强**：现有 buffer 策略继续可用，compaction 是可选叠加层

---

## 架构：Decorator Pattern

Compaction 作为独立 Decorator 包裹 MemoryStrategy，不侵入 AgentLoop 或 Channel 逻辑：

```
Channel (QQBot / HTTP)
  └── memory.getContext()
        └── CompactionStrategy        ← Decorator
              ├── estimateTokens()    → 超阈值？
              ├── [是] summarize()    → 调用 LLM 生成摘要
              └── BufferStrategy      ← 实际存储（可替换）
```

**关键优点**：任何 Channel、任何存储后端都能加 compaction，零侵入。

---

## 触发条件：Preflight + 动态阈值

每次 `getContext()` 时做 preflight 检查：

```typescript
const estimated = estimateTokens(messages) * SAFETY_MARGIN  // 1.2x
const contextWindow = MODEL_CONTEXT_WINDOWS[model] ?? 128_000
if (estimated > contextWindow * config.threshold) {
  await compact(sessionId, messages)
}
```

- **动态阈值**：`threshold × contextWindow`，换模型自动适配，不硬编码 token 数
- **token 估算**：`chars / 3.5`，无额外依赖，~20% 误差配安全系数足够
- **阈值默认值**：`0.75`（75% context window 时触发）

对比：
- Claw：依赖 LLM 报 overflow 错误后重试，多一次失败 RTT
- Hermes：preflight 但阈值是硬编码 token 数，换模型需手动调

---

## 压缩结构：三段式 + 摘要叠加

压缩后的 session 消息结构固定为三段：

```
┌─────────────────────────────────────────┐
│  [0] 系统人格消息（system）              │  ← 永不压缩
├─────────────────────────────────────────┤
│  [1] SUMMARY 消息（合成 user/assistant）│  ← 历次压缩的叠加产物
├─────────────────────────────────────────┤
│  [2..N] 最近 keepLast 条消息            │  ← 永不压缩
└─────────────────────────────────────────┘
```

### 摘要叠加（核心创新点）

**Claw** 每次重新摘要所有旧消息 → 代价高，且早期内容每次都重新处理  
**Hermes** 一次性替换中间段 → 历史摘要被丢弃，不累积  
**GeminiClaw** 摘要叠加：

```
新摘要 = summarize(旧摘要 + 待压缩消息)
```

- 识别现有 SUMMARY 消息（通过标记），将其内容作为 `previousSummary` 传入
- LLM 在生成新摘要时将旧摘要合并进来
- 每次压缩只处理"新增的待压缩消息"，不重复处理已摘要内容

**效果**：摘要随对话深度越来越精炼，信息不重复处理，不出现"摘要的摘要"失真。

---

## 摘要消息格式

为保持 Anthropic API 要求的 user/assistant 交替结构，摘要插入为两条合成消息：

```typescript
// 压缩后替换旧消息的两条 synthetic 消息
{
  role: "user",
  content: "[CONVERSATION_SUMMARY]\n{summaryText}\n[/CONVERSATION_SUMMARY]"
}
{
  role: "assistant",
  content: "Understood, continuing from this context."
}
```

`[CONVERSATION_SUMMARY]` 标记作用：
1. 下次压缩时识别"这条是摘要"，纳入 `previousSummary` 而非待压缩消息
2. 调试时可视化区分真实消息和合成摘要

---

## 摘要 Prompt

```
You are summarizing a conversation to preserve context within token limits.
Merge the following into a single concise summary.

{{#if previousSummary}}
PREVIOUS SUMMARY (already compressed):
{previousSummary}

NEW MESSAGES TO INCORPORATE:
{{/if}}
{messagesToCompress}

MUST PRESERVE:
- Ongoing topics and their current status
- User's stated preferences, habits, and goals
- Any specific values, names, identifiers mentioned — preserve exactly as written
  (UUIDs, file paths, IPs, URLs, numbers, dates)
- Decisions made and their rationale
- Open questions and unresolved items

PRIORITIZE recent content over older history.
Output only the summary text, no preamble or metadata.
```

---

## 配置项

```yaml
memory:
  strategy: buffer
  recentMessageLimit: 20       # buffer 窗口大小（触发压缩前的临时容量）
  compaction:
    enabled: true
    threshold: 0.75            # 触发阈值（占模型 context window 的比例）
    keepLastMessages: 10       # 尾部永不压缩的消息数
    model: "my-llm/cld-sonnet-4-6"   # 可选：独立摘要模型（省略则用主模型）
    safetyMargin: 1.2          # token 估算安全系数
```

---

## 文件结构（待实现）

```
src/memory/
  compaction/
    index.ts          ← CompactionStrategy（Decorator，实现 MemoryStrategy）
    estimator.ts      ← token 估算 + MODEL_CONTEXT_WINDOWS 表
    summarizer.ts     ← LLM 摘要调用（接受 router + model 参数）
    types.ts          ← CompactionConfig、SummaryMessage 等类型
  strategies/
    buffer.ts         ← 现有（不改）
    layered.ts        ← 现有（不改）
  strategy.ts         ← 工厂函数加入 compaction 装配逻辑
```

---

## 与两家方案对比

| 维度 | Claw | Hermes | GeminiClaw（本方案）|
|------|------|--------|---------------------|
| 触发方式 | 错误驱动 + 预判 | Preflight 固定阈值 | Preflight + 动态阈值 |
| 压缩算法 | 分块并行摘要 | 头尾保护一次替换 | 三段式 + 摘要叠加 |
| 摘要叠加 | ❌ | ❌ | ✅ |
| Tool pair 保护 | ✅ | ❌ | 暂缓（待 tool call 支持后补）|
| Memory flush 前置 | ✅ | ❌ | 暂缓（待持久化支持后补）|
| 独立摘要模型 | ✅ | ✅ | ✅ |
| 与存储层解耦 | ❌ 耦合 agent core | ❌ | ✅ Decorator |
| token 估算精度 | 高（pi-coding-agent）| 高（tiktoken）| 低（chars/3.5）但够用 |

---

## 待讨论细节

1. **`keepLastMessages` 的合理默认值**：10 条（5 轮）还是更多？QQBot 场景消息短，可以适当多保留
2. **摘要模型的选择**：用 sonnet 做摘要够吗？还是用 haiku 降成本？
3. **token 估算精度**：chars/3.5 误差约 ±20%，配 1.2x 安全系数是否足够？还是引入 tiktoken？
4. **跨 session 持久化**：当前进程重启消息全丢，compaction 意义打折。是否先做持久化？
5. **Tool pair 保护**：QQBot 接入 AgentLoop 后会有 tool call，需要保证 tool call/result 成对不被拆散

---

## 实现优先级建议

```
Phase 1（当前）：对齐 QQBotChannel → AgentLoop
Phase 2（下一步）：实现 CompactionStrategy（核心三段式 + 摘要叠加）
Phase 3（之后）：加 tool pair 保护
Phase 4（之后）：加持久化，compaction 才真正发挥长期价值
```
