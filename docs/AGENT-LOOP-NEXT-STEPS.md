# Agent Loop 下一步：预算演进 & Claude Sonnet Prompt 优化

> 日期：2026-06-13
> 基于：真实 LLM 验证报告 + OpenClaw/Hermes/Cursor 机制调研

## 一、maxTurns 是否还需要？

### 现状分析

当前 GeminiClaw 使用 `maxTurns=30` 作为硬性上限，配合 IterationBudget 的 grace call 机制。真实 LLM 测试表明：即使是 24 次工具调用的复杂任务，也只用了 7 轮——远低于 30 的上限。

### 业界对比

| 产品 | 主终止信号 | 硬性限制 | 弹性机制 |
|------|-----------|---------|---------|
| **Claude Code** | `stop_reason: end_turn`（模型自主决定） | 可选 `max_turns`（安全网，非主控） | 4 级上下文渐进压缩 + 多路径恢复 |
| **Cursor** | 硬性 tool call 限制 | 25（标准）/ 200（Max） | 用户手动 Continue |
| **Codex CLI** | 模型自主决定 | 未文档化 | 自动压缩 via summarization |
| **GeminiClaw（当前）** | maxTurns 硬限制 + no_tool_calls | 30 | grace call + 预算退款 |

### 结论：保留但重新定位

**建议：maxTurns 从"主控"降级为"安全网"，主终止信号改为模型自主决定。**

理由：
1. Claude Sonnet 在当前智力水平下，能正确判断任务何时完成（通过不再调用工具）
2. 真实测试中，所有任务都以 `stopReason: no_tool_calls` 结束，从未触发 `max_turns`
3. Claude Code 的实践证明：模型自主终止 + 高值安全网是最优解
4. 硬性低值限制反而可能在复杂任务中过早截断

### 推荐演进路径

```
Phase 1（当前）：maxTurns=30 + grace call + 预算退款
  ↓ 已验证有效，但 30 对复杂任务可能偏低
Phase 2（建议）：maxTurns=50 + 进度检测 + 上下文压缩
  ↓ 提高安全网阈值，增加"是否有进展"的检测
Phase 3（目标）：模型自主终止 + maxTurns=100（纯安全网）+ 上下文弹性管理
  ↓ 完全信任模型的终止判断，限制只防无限循环
```

### Phase 2 具体设计

```typescript
interface BudgetConfig {
  // 安全网（从 30 提升到 50）
  maxTurns: 50;

  // 进度检测（新增）
  progressDetection: {
    // 连续 N 轮工具结果相同 → warn
    staleResultThreshold: 3;
    // 连续 N 轮无新文件/无新信息 → soft halt + grace
    noNewInfoThreshold: 5;
  };

  // 上下文压缩（新增，参考 Claude Code Tier 1-3）
  contextCompression: {
    // 消息数超过此值时触发压缩
    messageCountThreshold: 40;
    // 压缩策略：清除旧工具结果的详细内容，保留摘要
    strategy: "summarize_old_tool_results";
  };

  // 保留现有机制
  graceCall: true;
  refundableTools: ["execute_script"];
}
```

### 为什么不完全去掉 maxTurns？

即使在 Phase 3，也需要一个高值安全网（100），因为：
1. 模型可能陷入"有工具调用但无进展"的循环（如反复 grep 同一个不存在的文件）
2. 网络/API 异常可能导致模型收到错误信息后无限重试
3. 成本控制——每轮都是一次 LLM API 调用

但这个安全网应该是"几乎不会触发"的值，而非日常工作的约束。

---

## 二、Claude Sonnet 专属 Prompt 优化

### 2.1 已知行为特征

Claude Sonnet 系列在 Agent 场景下有以下已知特征：

1. **不自然并行**：倾向于一次一个工具调用，需要明确提示
2. **过于冗长**：默认输出较长的解释性文本
3. **过于谨慎**：倾向于先描述计划再行动
4. **上下文腐烂**：长对话中容易忘记初始目标

### 2.2 Claude Code 的关键 Prompt 技巧

从 Claude Code 系统提示词（110+ 动态片段，~12000 tokens）中提取的核心模式：

**强制并行（MUST 级别）：**
```
When making multiple bash tool calls, you MUST send a single message with
multiple tool calls to run the calls in parallel. For example, if you need
to run "git status" and "git diff", send a single message with two tool calls.
```

**简洁输出约束：**
```
You MUST answer concisely with fewer than 4 lines (not including tool use
or code generation). You should minimize output tokens as much as possible
while maintaining helpfulness, quality, and accuracy.
```

**算法化流程（比规则列表更有效）：**
```
1. Use TodoWrite to plan the task if required
2. Use search tools to understand the codebase (extensively, in parallel)
3. Implement the solution using all tools available
4. Verify with tests
5. VERY IMPORTANT: Run lint and typecheck commands
```

**禁止前言/后语：**
```
You should NOT answer with unnecessary preamble or postamble.
Do not say "Let me check..." or "Now I'll test..." — just call the tool.
```

### 2.3 GeminiClaw Execution Bias 优化建议

当前 `src/agent/execution-bias.ts` 已经覆盖了基本的效率引导。基于 Claude Code 的实践，建议增强以下方面：

#### 增强 1：MUST 级别的并行强制

```typescript
// 当前（建议性）：
// "独立的只读操作（ls、grep、cat、ssh 查询）：在同一轮内一起发起，不要一个一个来。"

// 建议（强制性）：
// "你 MUST 在同一条消息中发起多个独立的工具调用。例如，如果需要读取 3 个文件，
//  MUST 发送一条包含 3 个 read 调用的消息，而不是 3 条各含 1 个调用的消息。"
```

#### 增强 2：输出简洁约束

```typescript
export const OUTPUT_DISCIPLINE = `
## 输出纪律

- 工具调用时不需要解释（"让我检查…""现在我来…"）——直接调用。
- 最终回答控制在必要的最少行数，不要重复工具已经输出的内容。
- 如果工具输出已经包含了答案，直接引用关键部分，不要全文复述。
`.trim();
```

#### 增强 3：Batch Tool 元工具模式

Anthropic 官方 Cookbook 明确建议：当 Claude Sonnet 不自然并行时，引入 batch tool 作为元工具。GeminiClaw 的 `execute_script` 已经部分实现了这个模式（将多个 shell 命令合并为一个脚本）。可以进一步泛化：

```typescript
// 概念：通用 batch_tool（未来考虑）
{
  name: "batch",
  description: "Execute multiple independent tool calls simultaneously. Use this when you need to call multiple tools that don't depend on each other's results.",
  parameters: {
    invocations: [
      { tool_name: "read", args: { path: "file1.ts" } },
      { tool_name: "read", args: { path: "file2.ts" } },
      { tool_name: "exec", args: { command: "git status" } },
    ]
  }
}
```

但当前 `execute_script` + 并行决策引擎已经足够，batch_tool 作为 Phase 3 考虑。

#### 增强 4：Prefill 技术（Claude 独有）

Claude API 允许预填充 Assistant 消息开头，可以用来：
- 跳过前言直接进入工具调用
- 强制特定输出格式
- 维持角色一致性

```typescript
// 在 chatFn 中，当检测到模型上一轮有工具调用时，
// 可以 prefill assistant 消息为空字符串，避免模型输出"好的，让我继续..."
```

#### 增强 5：Extended Thinking 集成

Claude Code 使用 `think` / `think hard` / `ultrathink` 关键词触发不同深度的思考。GeminiClaw 可以：

```typescript
// 在复杂任务开始时注入 thinking 提示
const PLANNING_HINT = `
Before executing, briefly plan your approach in your thinking.
Consider: what tools do you need? Can any be parallelized?
What's the minimum number of turns to complete this?
`;
```

### 2.4 完整的优化后 Execution Bias

```typescript
export const EXECUTION_BIAS = `
## 执行效率规则

### 并行工具调用（MUST）
- 你 MUST 在同一条消息中发起所有独立的工具调用。
- 例如：需要读取 3 个文件 → 一条消息包含 3 个 read 调用。
- 例如：需要 git status + ls + cat → 一条消息包含 3 个工具调用。
- 只有存在依赖关系时才分多轮（如：先 find 找到文件，再 read 该文件）。

### 碎步合并（MUST）
- 多个 shell 命令如果互不依赖，MUST 使用 execute_script 合并为一个脚本。
- 不要为每个 ls、grep、cat 各占一轮——它们可以合并。
- 优先使用 execute_script 工具将多步探查合并为一个脚本。

### 输出纪律
- 调用工具时不需要解释（"让我检查…""现在我来…"）——直接调用。
- 最终回答简洁，不要复述工具输出的全部内容。
- 如果工具输出已包含答案，直接引用关键部分。

### 空结果处理
- 工具返回空或弱结果：换一种查询方式，不要重复相同调用。
- 连续两次相同调用得到相同结果：停止重复，换策略或报告"找不到"。

### 验证与收尾
- 最终答案需要证据：工具输出、测试结果、文件内容。
- 用最小必要的验证步骤确认成功，不要过度验证。
`.trim();
```

### 2.5 关键差异：当前 vs 优化后

| 维度 | 当前 Execution Bias | 优化后 | 预期效果 |
|------|-------------------|--------|---------|
| 并行指令强度 | "不要一个一个来"（建议） | "MUST 在同一条消息中发起"（强制） | 并行率从 70%→90%+ |
| 输出冗长 | 未约束 | "不需要解释，直接调用" | 减少无用 token |
| 碎步合并 | "优先使用 execute_script" | "MUST 使用 execute_script 合并" | 合并率从 60%→80%+ |
| 示例 | 无 | 具体示例（3 文件→1 消息） | 模型更容易遵循 |

---

## 三、实施优先级

| 优先级 | 改动 | 复杂度 | 预期收益 |
|--------|------|--------|---------|
| P0 | 更新 Execution Bias（MUST 级别 + 示例） | 低（改 1 个文件） | 并行率 +20% |
| P1 | maxTurns 30→50 | 低（改 config） | 复杂任务不被截断 |
| P1 | 输出简洁约束 | 低（加 prompt 片段） | 减少 token 浪费 |
| P2 | 进度检测（stale result detection） | 中 | 替代硬性 turn 限制 |
| P2 | Prefill 技术集成 | 中 | 跳过前言 |
| P3 | 上下文压缩（Tier 1: 清除旧工具结果） | 高 | 支持超长任务 |
| P3 | 通用 batch_tool 元工具 | 中 | 泛化并行能力 |

---

## 四、参考来源

- Claude Code v2.1.88 系统提示词分析
- Anthropic "Building Effective Agents" 官方指南
- Anthropic "Effective Context Engineering for AI Agents" 工程博客
- Anthropic Cookbook: Claude 3.7 Sonnet parallel tool use workaround
- Cursor Agent 系统提示词（Claude 3.7/4 Sonnet）
- OpenAI Codex CLI 架构分析
