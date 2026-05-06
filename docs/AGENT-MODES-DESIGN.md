# GeminiClaw Agent Modes - 设计文档

> **状态:** 设计稿,待实现
> **作者:** 李平江 + 观澜
> **日期:** 2026-05-06
> **参考:**
> - Anthropic, "Building Effective Agents" (Dec 2024) - 五种 workflow 模式分类
> - Andrew Ng / DeepLearning.AI, "Agentic Design Patterns" (2024) - Reflection/Self-Refine 模式
> - Yao et al., "ReAct" (2022) - Reasoning + Acting 论文
> - LangChain, "Plan-and-Execute Agents" (2023)
> - Chip Huyen, "AI Engineering" O'Reilly (2025) - compound mistakes 分析
> - Hermes 源码:`clarify_tool.py` / `todo_tool.py` / `tool_guardrails.py`
> - OpenClaw 源码:`agent-runner.runtime-*.js`(`plan` stream / `approval` stream)
> - 学术论文:Self-Refine (Madaan 2023)、Reflexion (Shinn 2023)、CRITIC (Gou 2024)

---

## 一、当前 AgentLoop 是什么模式?

GeminiClaw 当前 `AgentLoop` 是 **Auto 模式**(ReAct 的宽松实现)。

**标准 ReAct(论文定义):**
```
Thought → Act(单个工具)→ Observe → Thought → Act → ...
每 turn 只做一个 Action,严格"一步一观察"
```

**GeminiClaw 当前 AgentLoop:**
```
LLM call → 可能多个 tool_calls(并发或串行)→ 所有结果一次性返回 → 下一轮
```

差异不大:现代大模型(Claude、GPT-4)已经足够聪明,并发工具时也能正确推理。Anthropic 自己的文档也没有强调"必须每步一个工具"。

**结论:当前 AgentLoop 就是 Auto 模式,不需要改。**

---

## 二、四种 Agent 模式

### 行业背景

Anthropic (2024) 把 agent 行为归纳为五种基础模式:
Prompt Chaining、Routing、Parallelization、**Orchestrator-Workers**、**Evaluator-Optimizer**。

LangChain 的研究指出 ReAct 的两个缺陷:
1. 每步都要调大模型,成本高
2. 每次只看一步,无法对整个任务推理,导致次优路径

Plan-and-Execute 通过显式 planning 阶段解决这两个问题。

Chip Huyen (2025) 指出:**compound mistakes** 是 agent 最大失败模式--每步 95% 准确率,10 步后整体准确率只剩 60%。

这些研究共同指向:agent 需要在"全自主"和"完全人工"之间提供**可控的中间地带**。

---

### 2.1 Auto 模式(当前默认)

**对应:** ReAct / Orchestrator-Workers(无约束)

**行为:**
- LLM 自主决定每 turn 调用多少个工具、调哪些
- 工具可并发执行
- 直到 `no_tool_calls` 或 `max_turns` 停止
- 无任何人工介入点

**适用场景:** 简单任务、用户信任 agent、低风险操作

**当前实现:** ✅ 已有(AgentLoop 默认行为)

---

### 2.2 Step 模式(ReAct 严格版)

**对应:** 标准 ReAct(Yao et al., 2022)

**行为:**
- 每 turn 最多执行 **1 个工具调用**(`maxToolCallsPerTurn: 1`)
- 严格"一步一观察":执行完看结果,再决定下一步
- 加入 **tool_guardrails**(参考 Hermes):相同工具连续失败 N 次 → 中止并提示用户
- 用户可以随时看到 agent 的每一步

**适用场景:** 调试、学习、需要观察 agent 推理过程、中等风险操作

**实现方式:**
```typescript
// AgentConfig 新增
maxToolCallsPerTurn?: number  // step 模式设为 1

// tool_guardrails(参考 Hermes tool_guardrails.py)
interface GuardrailConfig {
  sameToolFailureWarnAfter: number   // 默认 3
  sameToolFailureHaltAfter: number   // 默认 8
  noProgressWarnAfter: number        // 默认 2
  noProgressHaltAfter: number        // 默认 5
}
```

**依赖:** 无(纯 AgentLoop 内部改动)

---

### 2.3 Plan 模式(Plan-and-Execute)

**对应:** LangChain Plan-and-Execute(Wang et al., 2023)/ Hermes `todo_tool`

**行为:**
1. **Planning Phase**:agent 先输出结构化 plan(禁止调工具),用户确认
2. **Execution Phase**:按 plan 逐步执行,每步可见
3. **Re-planning**:执行失败或偏离时,重新规划(不是硬跑到底)

**与 Hermes todo_tool 的区别:**
- Hermes todo_tool:agent **自愿**调用,行为由 system prompt 引导(语义约束)
- GeminiClaw Plan 模式:Planning Phase 期间**物理禁止工具调用**,用户确认前不能执行(流程约束)

**实现方式(需要 interrupt point 基础设施):**
```typescript
// 新增 AgentEvent 类型
| { type: 'plan_ready'; plan: PlanStep[]; planId: string }
| { type: 'checkpoint_reached'; checkpointId: string; message: string }

// PlanStep
interface PlanStep {
  id: string
  description: string
  toolHint?: string   // agent 预计用什么工具
  status: 'pending' | 'in_progress' | 'done' | 'failed'
}

// HTTP API 新增
POST /v1/agent/resume   // 用户确认 plan 后恢复执行
```

**依赖:** interrupt point 基础设施(见第三节)

---

### 2.4 高置信度模式(Uncertainty-First)

**对应:** Human-in-the-Loop Checkpoint(Anthropic 推荐)+ Hermes `clarify_tool` 的强化版

**行为:**
1. **Uncertainty Phase**:执行任何行动工具(exec/write/edit)之前,agent **必须**列出所有不确定点
2. **Clarification Loop**:用户逐一回答,agent 更新认知
3. **Cleared Check**:所有 `blocking` 级别的不确定点 resolved → 才允许执行
4. 用户可以随时说"不确定的你自己决定,开始吧"来 override

**与 Hermes clarify_tool 的本质区别:**
- Hermes clarify:agent **自愿**调用(语义约束,可能"忘记")
- 高置信度模式:`beforeToolCall` hook **物理拦截**行动工具,未 cleared 就阻止(流程约束)

这是你提出的最创新的模式:**不约束 agent 做什么,而约束 agent 在"知道什么"之前不能做**。

**实现方式:**
```typescript
// 新增 clarify_uncertainty tool
interface UncertaintyItem {
  id: string
  question: string
  impact: 'blocking' | 'optional'
  resolved: boolean
  answer?: string
}

// beforeToolCall hook 物理拦截
if (mode === 'high-confidence' && isMutatingTool(tc.name)) {
  const cleared = session.get('uncertaintyCleared')
  if (!cleared) {
    return { block: true, reason: 'Must resolve all blocking uncertainties first' }
  }
}

// 终止条件(防止无限追问)
maxUncertaintyRounds: number  // 默认 2
```

**依赖:** interrupt point 基础设施 + clarify_uncertainty tool

---

### 2.5 Reflection 模式(自评重写循环)

**对应的成熟系统和研究：**
- **Andrew Ng / DeepLearning.AI** “Agentic Design Patterns Part 2: Reflection” (2024) — 工程实践最成熟的概念源头
- 学术论文：**Self-Refine** (Madaan 2023)、**Reflexion** (Shinn 2023)、**CRITIC** (Gou 2024)
- Anthropic 将其归类为 “Evaluator-Optimizer workflow”，同一思想的不同命名

> 注：这个模式没有像 Hermes `clarify_tool` 那样现成的生产级代码实现，更多是学术论文和理论框架的级别。不过 Andrew Ng 有明确的工程实验数据支撑它的价值。

**核心思想：**

> “如果你让模型生成了不满意的输出，你会给它反馈让它重写。
> 现在把这个反馈步骤自动化——让模型自动批评自己的输出并改进。这就是 Reflection 的精高。”
> —— Andrew Ng

**与 Evolution Engine 的区别（很重要）：**

| | Reflection 模式 | Evolution Engine |
|-|----------------|------------------|
| 作用对象 | 当前任务的**输出**（文案、代码、回答） | GeminiClaw **自身代码** |
| 循环周期 | 单次任务内，秒到分钟 | 跨 session，小时到天 |
| 目标 | 输出质量提升 | 系统能力进化 |

**为什么要加这个模式？**

前四种模式都是“执行前”的控制。Reflection 是“执行后”的质量保障，补全闭环。

Andrew Ng 的实验数据：GPT-3.5 全自主模式下 HumanEval 准确率 48.1%，加上 Reflection 循环后达到 **95.1%**。

**典型场景：**
```
用户：帮我写一份技术方案
→ Agent 写了一版
→ Evaluator LLM：“结构不清晰，缺少风险分析”
→ Agent 根据反馈重写
→ Evaluator LLM：“通过”
→ 返回给用户
```

**实现方式：**
```typescript
// AgentConfig 新增
evaluator?: {
  enabled: boolean
  rubric: string        // 评估标准（例：“代码必须有单元测试”）
  maxRetries: number    // 默认 2，防止无限循环
  model?: string        // 可用较小模型做评估，节省成本
}

// 新增 AgentEvent
| { type: 'reflection_result'; feedback: string; willRetry: boolean; attempt: number }
```

**依赖：** 无（纯 AgentLoop 内部改动，不需要 interrupt point）

---

## 三、共同依赖:interrupt point 基础设施

Plan 模式和高置信度模式都需要 **agent 执行到某个点时暂停,等待外部输入,然后继续**。

这是 GeminiClaw 目前最大的架构缺口(Hermes 有 `interrupt()`,OpenClaw 有 `approval` stream,GeminiClaw 没有)。

**设计:**

```typescript
// AgentLoop 新增状态
type LoopState = 'running' | 'paused' | 'done'

// 新增 AgentEvent
| { type: 'paused'; pauseId: string; reason: string; payload: unknown }

// AgentLoop 新增方法
resume(pauseId: string, userInput: unknown): void

// SessionStore 新增字段
pausedLoops: Map<string, PausedLoopState>

// HTTP API 新增
POST /v1/agent/resume   { pauseId, input }
GET  /v1/agent/status   { state: 'running' | 'paused' | 'idle', pauseId? }
```

**实现原理:**
- AgentLoop 内部用 `Promise` + resolve 函数实现暂停/恢复
- 暂停时把 `resolve` 函数存起来,`resume()` 时调用它
- SSE stream 保持连接,暂停期间不关闭

---

## 四、模式对比总览

| 模式 | 行业对应 | 控制权 | 人工介入点 | 适用场景 |
|------|---------|--------|-----------|---------|
| Auto | ReAct / Orchestrator-Workers | Agent 全自主 | 无 | 简单任务、低风险 |
| Step | 标准 ReAct | Agent 自主,每步可观测 | 随时可中断 | 调试、学习过程 |
| Plan | Plan-and-Execute | 人在 Plan 阶段确认 | Plan 完成后 | 复杂多步任务 |
| 高置信度 | Human-in-the-Loop Checkpoint | 人在执行前消除不确定性 | 首次行动前 | 高风险操作、生产环境 |
| Reflection | Reflection / Self-Refine | Agent 自评,人设定标准 | 质量标准定义时 | 需要质量保证的输出（**暂不实现**）|

---

## 五、实现优先级

| 优先级 | 内容 | 依赖 | 工作量 |
|--------|------|------|--------|
| P0 | **interrupt point 基础设施**(AgentLoop 暂停/恢复 + resume API) | 无 | 中 |
| P1 | **Step 模式**(maxToolCallsPerTurn + tool_guardrails) | 无 | 小 |
| P2 | **Plan 模式**(todo tool + plan_ready 事件 + resume) | interrupt point | 中 |
| P3 | **高置信度模式**(clarify_uncertainty + beforeToolCall 拦截) | interrupt point | 中 |

**interrupt point 是 Plan 和高置信度的共同前置条件，应该先做。**

> Reflection 模式暂不实现。可行性和实际效果尚不明确，等遇到具体场景需求时再评估。

---

## 六、不做"模式枚举"的原因

参考 Anthropic 和 Hermes 的设计哲学:**不做 `mode` 枚举,而是可组合的行为层**。

- Hermes 没有"模式",而是 `todo_tool` + `clarify_tool` + `tool_guardrails` 的组合
- OpenClaw 没有"模式",而是 `plan` stream + `approval` stream + `interrupt` 的组合
- 模式枚举会造成组合爆炸(5 种模式的排列组合)

**GeminiClaw 的实现方式:**

```typescript
interface AgentConfig {
  // 现有
  maxTurns?: number
  toolExecutionMode?: 'parallel' | 'sequential'

  // 新增:可独立开关的行为层
  maxToolCallsPerTurn?: number        // Step 模式核心
  guardrails?: GuardrailConfig        // tool_guardrails
  planning?: PlanningConfig           // Plan 模式(需要 interrupt point)
  uncertaintyCheck?: UncertaintyConfig // 高置信度模式(需要 interrupt point)
  // evaluator?: EvaluatorConfig      // Reflection 模式（暂不实现，待观察）

  // 快捷预设(底层仍是上面的组合)
  preset?: 'auto' | 'step' | 'plan' | 'high-confidence'
}
```

`preset` 是用户友好的快捷方式,底层展开为具体的配置组合。高级用户可以自由组合。

---

## 七、最有价值的组合

**高置信度 + Plan + Step**(三层控制):
```
先消除不确定性(高置信度)
→ 再列完整计划(Plan)
→ 再一步步执行(Step)
```

这是目前行业里最严谨的 human-in-the-loop 模式，对高风险任务（生产环境操作、数据库变更、不可逆操作）价值极大。

---

*参考资料:*
- *Anthropic, "Building Effective Agents", Dec 2024*
- *Yao et al., "ReAct: Synergizing Reasoning and Acting in Language Models", 2022*
- *Wang et al., "Plan-and-Solve Prompting", 2023*
- *Xu et al., "ReWOO: Decoupling Reasoning from Observations", 2023*
- *Chip Huyen, "AI Engineering", O'Reilly, 2025*
- *Hermes agent/tool_guardrails.py, tools/clarify_tool.py, tools/todo_tool.py*
- *OpenClaw dist/agent-runner.runtime-*.js (plan stream, approval stream)*
