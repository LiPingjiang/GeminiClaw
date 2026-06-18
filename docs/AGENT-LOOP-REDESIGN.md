# GeminiClaw Agent Loop 改造设计

> 综合 OpenClaw（循环检测 + Execution Bias + 智能截断）与 Hermes（可退款预算 + 细粒度并行 + 三层结果防爆 + 优雅收尾）的经验，对 GeminiClaw 的 agent 执行循环进行系统性改造。

## 一、问题诊断回顾

龙股 session 实测数据：用户说一句"继续"，agent 跑了 37 个工具往返（76 条消息），全部在同一秒内批量写入。根因：

| 问题 | 现状 | 影响 |
|------|------|------|
| maxTurns 过高 | config.yaml 设为 100 | 给了模型无限试错空间 |
| exec 强制串行 | `SEQUENTIAL_TOOLS = {exec, write, edit}` | 只读探查也一步一步来 |
| 无效率提示词 | AGENT.md 无并行/批量引导 | 模型默认一次一小步 |
| 截断策略粗暴 | 简单砍尾 `content.slice(0, max)` | 丢失尾部错误信息→重试循环 |
| 无合并碎步机制 | 每个 ls/grep/cat 各占一个 turn | 步骤数线性膨胀 |
| 预算耗尽硬切 | 直接停止 + 提示"回复继续" | 无总结，用户不知道做了什么 |

## 二、改造总览

6 个模块，按依赖关系分 3 批实施：

```
批次 1（基础设施，无依赖）：
  ├── M1: 智能截断（head+tail + 溢写预览）
  ├── M2: 细粒度并行决策引擎
  └── M3: Execution Bias 提示词注入

批次 2（依赖 M1）：
  ├── M4: 可退款迭代预算 + 优雅收尾
  └── M5: execute_script 工具（合并碎步）

批次 3（依赖 M4）：
  └── M6: 配置调优 + 模板提示词固化
```

---

## 三、模块详细设计

### M1: 智能截断 + 三层结果防爆

**文件：** `src/agent/tool-result-truncation.ts`（新建）

**设计理念：** 从 OpenClaw 的 head+tail 智能截断 + Hermes 的三层防爆中取精华。

#### 三层策略

```typescript
// Layer 1: 单结果截断（改进现有 truncate）
const MAX_TOOL_RESULT_CHARS = 12_000;  // 从 8000 提升到 12000
const HEAD_CHARS = 4_000;
const TAIL_CHARS = 3_000;

// Layer 2: 大结果溢写（Hermes 风格）
const PERSIST_THRESHOLD = 50_000;      // 超过 50K 字符溢写到文件
const PREVIEW_CHARS = 2_000;           // 回传给模型的预览长度

// Layer 3: 整轮聚合预算
const TURN_BUDGET_CHARS = 80_000;      // 单轮所有工具结果总和上限
```

#### 核心接口

```typescript
export interface TruncationResult {
  content: string;           // 截断/预览后的内容
  persisted?: string;        // 溢写文件路径（如有）
  originalLength: number;
  wasTruncated: boolean;
}

export function truncateToolResult(content: string, toolName: string): TruncationResult;
export function enforceTurnBudget(results: TruncationResult[]): TruncationResult[];
```

#### head+tail 智能截断逻辑

```typescript
function hasImportantTail(text: string): boolean {
  const tail = text.slice(-2000).toLowerCase();
  return (
    /\b(error|exception|failed|fatal|traceback|panic|exit code)\b/.test(tail) ||
    /\}\s*$/.test(tail.trim()) ||           // JSON 收尾
    /\b(total|summary|result|done)\b/.test(tail)
  );
}

function smartTruncate(content: string): string {
  if (content.length <= MAX_TOOL_RESULT_CHARS) return content;

  if (hasImportantTail(content)) {
    // 保留头尾，省略中间
    const head = content.slice(0, HEAD_CHARS);
    const tail = content.slice(-TAIL_CHARS);
    const omitted = content.length - HEAD_CHARS - TAIL_CHARS;
    return `${head}\n\n⚠️ [... ${omitted} chars omitted — showing head and tail ...]\n\n${tail}`;
  }

  // 普通截断：保留头部
  return content.slice(0, MAX_TOOL_RESULT_CHARS) +
    `\n...[truncated ${content.length - MAX_TOOL_RESULT_CHARS} chars]`;
}
```

#### 溢写机制

```typescript
// 不溢写的工具（防死循环，学 Hermes 的 PINNED_THRESHOLDS）
const NEVER_PERSIST = new Set(["read", "read_file"]);

function maybePersist(content: string, toolName: string, sessionId: string): TruncationResult {
  if (content.length < PERSIST_THRESHOLD || NEVER_PERSIST.has(toolName)) {
    return { content: smartTruncate(content), originalLength: content.length, wasTruncated: content.length > MAX_TOOL_RESULT_CHARS };
  }

  // 溢写到临时文件
  const filePath = `/tmp/geminiclaw-results/${sessionId}/${randomUUID()}.txt`;
  writeFileSync(filePath, content);

  const preview = content.slice(0, PREVIEW_CHARS);
  const summary = `${preview}\n\n📁 [Full output (${content.length} chars) saved to: ${filePath}]\n` +
    `Use \`read\` tool to access the full content if needed.`;

  return { content: summary, persisted: filePath, originalLength: content.length, wasTruncated: true };
}
```

---

### M2: 细粒度并行决策引擎

**文件：** `src/agent/parallel-decision.ts`（新建）

**设计理念：** 从 Hermes 的路径作用域 + 重叠检测中学习，但简化为适合 GeminiClaw 的版本。

#### 核心分类

```typescript
/** 永远可以并行的只读工具 */
const ALWAYS_PARALLEL = new Set([
  "read", "web_search", "web_fetch", "grep", "repo_map",
  "list_agents", "list_sessions", "read_session",
  "memory_search", "memory_inspect", "view_image",
  "db_query", "dragon_api",
]);

/** 永远不能并行的工具 */
const NEVER_PARALLEL = new Set([
  "clarify_uncertainty", "create_agent", "switch_agent",
]);

/** 路径作用域工具：同路径冲突则串行，不同路径可并行 */
const PATH_SCOPED = new Set(["write", "edit"]);

/** exec 的并行判定：只读命令可并行，写入命令串行 */
const DESTRUCTIVE_PATTERNS = [
  /\brm\s/, /\bmv\s/, /\bcp\s/, /\bkill\b/, /\bsystemctl\s+(restart|stop|start)/,
  /\bpkill\b/, /\bchmod\b/, /\bchown\b/, /\b(cat|tee)\s*>/, /\bsed\s+-i/,
  /\bpython3?\s+.*\.(py|sh)\b/,  // 脚本执行视为可能有副作用
];
```

#### 决策函数

```typescript
export interface ParallelDecision {
  canParallelize: boolean;
  reason?: string;
  groups?: ToolCall[][];  // 如果部分可并行，分组执行
}

export function decideParallelization(toolCalls: ToolCall[]): ParallelDecision {
  if (toolCalls.length <= 1) return { canParallelize: false, reason: "single call" };

  // 含 NEVER_PARALLEL → 全部串行
  if (toolCalls.some(tc => NEVER_PARALLEL.has(tc.name))) {
    return { canParallelize: false, reason: "contains never-parallel tool" };
  }

  // 全是 ALWAYS_PARALLEL → 直接并行
  if (toolCalls.every(tc => ALWAYS_PARALLEL.has(tc.name))) {
    return { canParallelize: true };
  }

  // exec 工具：检查命令是否只读
  const execCalls = toolCalls.filter(tc => tc.name === "exec");
  const hasDestructiveExec = execCalls.some(tc => {
    const cmd = String(tc.args.command ?? "");
    return DESTRUCTIVE_PATTERNS.some(p => p.test(cmd));
  });

  if (hasDestructiveExec) {
    return { canParallelize: false, reason: "contains destructive exec command" };
  }

  // PATH_SCOPED 工具：检查路径重叠
  const pathScopedCalls = toolCalls.filter(tc => PATH_SCOPED.has(tc.name));
  if (pathScopedCalls.length > 1) {
    const paths = pathScopedCalls.map(tc => String(tc.args.path ?? tc.args.file ?? ""));
    if (pathsOverlap(paths)) {
      return { canParallelize: false, reason: "path-scoped tools with overlapping paths" };
    }
  }

  // 混合情况：只读 exec + 只读工具 → 可并行
  return { canParallelize: true };
}

function pathsOverlap(paths: string[]): boolean {
  const sorted = paths.map(p => p.split("/")).sort((a, b) => a.length - b.length);
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      if (isPrefix(sorted[i], sorted[j])) return true;
    }
  }
  return false;
}

function isPrefix(shorter: string[], longer: string[]): boolean {
  return shorter.every((seg, idx) => longer[idx] === seg);
}
```

#### 对 loop.ts 的改动

替换现有的 `shouldParallelize` 方法：

```typescript
// 旧：
private shouldParallelize(toolCalls: ToolCall[]): boolean {
  if (this.config.toolExecutionMode === "sequential") return false;
  return toolCalls.every((tc) => !SEQUENTIAL_TOOLS.has(tc.name));
}

// 新：
private shouldParallelize(toolCalls: ToolCall[]): boolean {
  if (this.config.toolExecutionMode === "sequential") return false;
  const decision = decideParallelization(toolCalls);
  return decision.canParallelize;
}
```

---

### M3: Execution Bias 提示词注入

**文件：** `src/agent/execution-bias.ts`（新建）

**设计理念：** 综合 OpenClaw 的 Execution Bias + Hermes 的按模型分发，生成一段效率引导文本，注入到 system prompt 尾部。

#### 通用效率引导（所有模型）

```typescript
export const EXECUTION_BIAS = `
## 执行效率规则

### 工具调用原则
- 可执行的请求：本轮直接行动，不要只描述计划。
- 独立的只读操作（ls、grep、cat、ssh 查询）：在同一轮内一起发起，不要一个一个来。
- 有依赖的操作：按依赖顺序串行。
- 破坏性操作（rm、重启服务、写入文件）：单独执行并验证。

### 避免碎步
- 多个 ssh 命令如果互不依赖，合并为一条：\`cmd1 && cmd2 && cmd3\` 或用分号连接。
- 不要为每个 ls、grep、cat 各占一轮——它们可以合并。
- 如果需要检查多个文件/目录，一条命令搞定：\`ls dir1/ dir2/ dir3/\`

### 空结果处理
- 工具返回空或弱结果：换一种查询方式（不同路径、不同关键词、不同命令），不要重复相同调用。
- 连续两次相同调用得到相同结果：停止重复，换策略或报告"找不到"。

### 验证与收尾
- 最终答案需要证据：工具输出、测试结果、文件内容。
- 用最小必要的验证步骤确认成功，不要过度验证。
- 不要为常规工具调用写解说（"让我检查…""现在测试…"），直接调用。
`;
```

#### 注入方式

在 `loop.ts` 的 system prompt 组装处追加：

```typescript
// 在 run() 方法开头，组装 system prompt 时：
const fullSystemPrompt = this.config.systemPrompt
  ? `${this.config.systemPrompt}\n\n${EXECUTION_BIAS}`
  : EXECUTION_BIAS;
```

---

### M4: 可退款迭代预算 + 优雅收尾

**文件：** `src/agent/iteration-budget.ts`（新建）

**设计理念：** 从 Hermes 学习可退款预算 + 宽限收尾，替代粗暴的 maxTurns 硬切。

#### IterationBudget 类

```typescript
export class IterationBudget {
  private _used = 0;
  private _graceUsed = false;

  constructor(
    private readonly cap: number,
    private readonly graceAllowed: boolean = true,
  ) {}

  get used(): number { return this._used; }
  get remaining(): number { return Math.max(0, this.cap - this._used); }
  get exhausted(): boolean { return this._used >= this.cap; }
  get canGrace(): boolean { return this.graceAllowed && !this._graceUsed && this.exhausted; }

  /** 消耗一格预算。返回 false 表示已耗尽（需检查 canGrace）。 */
  consume(): boolean {
    if (this._used < this.cap) {
      this._used++;
      return true;
    }
    return false;
  }

  /** 退款一格（用于 execute_script 等合并工具）。 */
  refund(): void {
    if (this._used > 0) this._used--;
  }

  /** 使用宽限位（仅一次）。 */
  useGrace(): boolean {
    if (!this.canGrace) return false;
    this._graceUsed = true;
    return true;
  }
}
```

#### 优雅收尾机制

当预算耗尽时，不是直接停止，而是：

```typescript
// 在 loop.ts 的 while 循环条件改为：
while (budget.remaining > 0 || budget.canGrace) {
  if (budget.exhausted && budget.canGrace) {
    // 宽限轮：注入收尾指令，禁用工具
    budget.useGrace();
    const summaryPrompt = "你已达到本次执行的迭代上限。请总结你已完成的工作和当前状态，不要再调用工具。";
    messages = [...messages, { role: "user", content: summaryPrompt }];
    // 本轮调用 LLM 时不传 tools，强制产出文本
    response = await this.chatFn(messages, { model: params.model });
    yield { type: "message_delta", delta: response.content };
    yield { type: "agent_end", totalTurns: turn, stopReason: "max_turns" };
    return;
  }

  budget.consume();
  // ... 正常循环逻辑 ...
}
```

#### 退款触发点

```typescript
// 在工具执行完成后，如果工具是 execute_script：
if (tc.name === "execute_script") {
  budget.refund();
}
```

---

### M5: execute_script 工具（合并碎步）

**文件：** `src/tools/execute_script.ts`（新建）

**设计理念：** 从 Hermes 的 `execute_code` 学习——让模型把多个碎步合并成一个脚本一次性执行，且不消耗迭代预算。

#### 工具定义

```typescript
registry.register({
  name: "execute_script",
  description: `Execute a multi-line bash script. Use this when you need to run multiple commands
that would otherwise require separate tool calls. The script runs as a single unit.

PREFER this over multiple separate 'exec' calls when:
- You need to run 3+ independent commands (ls, grep, cat, etc.)
- Commands have simple sequential dependencies (cd && cmd1 && cmd2)
- You're doing exploratory work (checking multiple files/directories)

The script runs in sh with 'set -e' (stops on first error).
Output from all commands is collected and returned together.`,
  schema: {
    type: "object",
    properties: {
      script: {
        type: "string",
        description: "Multi-line bash script to execute",
      },
      timeout: {
        type: "number",
        description: "Timeout in seconds (default 60)",
      },
      workdir: {
        type: "string",
        description: "Working directory",
      },
    },
    required: ["script"],
  },
  handler: executeScriptHandler,
  toolset: ["default"],
  requiresApproval: true,
  executionMode: "sequential",
});
```

#### 实现

```typescript
async function executeScriptHandler(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const script = String(params.script);
  const timeout = (params.timeout as number) ?? 60;
  const workdir = (params.workdir as string) ?? ctx.workdir;

  // 安全检查：脚本不能太长（防止注入）
  if (script.length > 10_000) {
    return { type: "error", error: "Script too long (max 10000 chars)" };
  }

  return new Promise(resolve => {
    let output = "";
    let timedOut = false;

    // 用 set -e 确保出错即停
    const fullScript = `set -e\n${script}`;
    const proc = spawn("sh", ["-c", fullScript], { cwd: workdir, env: process.env });

    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill("SIGTERM");
      resolve({ type: "error", error: `Script timed out after ${timeout}s\nPartial output:\n${output.slice(0, 4000)}` });
    }, timeout * 1000);

    proc.stdout.on("data", chunk => { output += chunk.toString(); });
    proc.stderr.on("data", chunk => { output += chunk.toString(); });

    proc.on("close", code => {
      if (timedOut) return;
      clearTimeout(timer);
      if (code !== 0) {
        resolve({ type: "error", error: `Script exited with code ${code}\n${truncateOutput(output)}` });
      } else {
        resolve({ type: "text", text: truncateOutput(output) });
      }
    });
  });
}
```

#### 预算退款集成

在 `loop.ts` 中，工具执行完成后：

```typescript
// execute_script 不消耗预算（鼓励合并碎步）
for (const tc of toolCallsToRun) {
  if (tc.name === "execute_script") {
    budget.refund();
  }
}
```

---

### M6: 配置调优 + 模板提示词固化

#### config.yaml 调整

```yaml
agent:
  maxTurns: 40          # 从 100 降到 40（有优雅收尾兜底）
  timeoutSeconds: 180
```

#### dragon-stock AGENT.md 追加

在龙股模板的 AGENT.md 末尾追加经验固化：

```markdown
## 远程操作最佳实践

### SSH 命令合并
- 多个独立查询合并为一条：`ssh tencent "ls dir1/ && cat file1 && grep pattern file2"`
- 或使用 `execute_script` 工具编写多行脚本一次性执行

### 文件写入
- 远端写文件统一用 Python heredoc 方式：
  ```
  ssh tencent "python3 << 'PYEOF'
  with open('/path/to/file', 'w') as f:
      f.write('''内容''')
  PYEOF"
  ```
- 不要用 echo/cat heredoc（换行和引号会出问题）
- 不要用 inline python3 -c（同样的转义问题）

### 探查策略
- 先用一条命令摸清全貌（find、ls -R、tree），再针对性深入
- 不要逐个目录 ls、逐个文件 cat——合并为一条命令
```

---

## 四、对 loop.ts 的整体改动摘要

```typescript
// src/agent/loop.ts 改动点：

// 1. 导入新模块
import { truncateToolResult, enforceTurnBudget } from "./tool-result-truncation.js";
import { decideParallelization } from "./parallel-decision.js";
import { IterationBudget } from "./iteration-budget.js";
import { EXECUTION_BIAS } from "./execution-bias.js";

// 2. 删除旧的 SEQUENTIAL_TOOLS 常量
// const SEQUENTIAL_TOOLS = new Set(["exec", "write", "edit"]);  // 删除

// 3. 构造函数中组装 system prompt
const fullSystemPrompt = this.config.systemPrompt
  ? `${this.config.systemPrompt}\n\n${EXECUTION_BIAS}`
  : "";

// 4. run() 方法中用 IterationBudget 替代 maxTurns 计数器
const budget = new IterationBudget(maxTurns, /* graceAllowed */ true);

// 5. while 循环条件改为预算驱动
while (budget.remaining > 0 || budget.canGrace) { ... }

// 6. shouldParallelize 改用 decideParallelization
private shouldParallelize(toolCalls: ToolCall[]): boolean {
  if (this.config.toolExecutionMode === "sequential") return false;
  return decideParallelization(toolCalls).canParallelize;
}

// 7. truncate 改用 smartTruncate
// 旧：content.slice(0, max) + "...[truncated]"
// 新：truncateToolResult(content, toolName)

// 8. execute_script 退款
if (tc.name === "execute_script") budget.refund();

// 9. 预算耗尽时优雅收尾（见 M4）
```

---

## 五、新增文件清单

```
src/agent/
├── loop.ts                      ← 改动（主循环重构）
├── types.ts                     ← 改动（新增 IterationBudgetConfig）
├── guardrails.ts                ← 不动（已经很好）
├── tool-result-truncation.ts    ← 新建（M1）
├── parallel-decision.ts         ← 新建（M2）
├── execution-bias.ts            ← 新建（M3）
└── iteration-budget.ts          ← 新建（M4）

src/tools/
├── execute_script.ts            ← 新建（M5）
└── exec.ts                      ← 改动（移除 executionMode: "sequential"）
```

---

## 六、测试计划

每个模块配套单元测试：

| 模块 | 测试文件 | 关键用例 |
|------|----------|----------|
| M1 | `tool-result-truncation.test.ts` | 短内容不截断、head+tail 保留错误信息、溢写触发、read 工具不溢写、整轮预算执行 |
| M2 | `parallel-decision.test.ts` | 全只读并行、含破坏性 exec 串行、路径重叠串行、路径不重叠并行 |
| M3 | `execution-bias.test.ts` | 提示词注入正确、空 systemPrompt 时也注入 |
| M4 | `iteration-budget.test.ts` | 消耗/退款/宽限位/exhausted 判定 |
| M5 | `execute_script.test.ts` | 正常执行、超时、set -e 出错即停、脚本过长拒绝 |

集成测试：用龙股 session 的典型场景（"继续"→修复云端代码）做 replay，验证步骤数从 37 降到 ≤15。

---

## 七、预期效果

| 指标 | 改造前 | 改造后（预期） |
|------|--------|---------------|
| 单次"继续"的工具往返 | 37 | ≤15 |
| 只读探查的并行率 | 0%（全串行） | ~70%（只读 exec 并行） |
| 尾部错误信息丢失率 | 高（简单砍尾） | ~0%（head+tail 保留） |
| 预算耗尽时的用户体验 | 硬切 + "回复继续" | 优雅总结已完成工作 |
| 碎步合并率 | 0% | ~40%（execute_script 引导） |

---

## 八、实施顺序与风险

### 推荐实施顺序

1. **M3（提示词）** → 零代码改动，纯 prompt，立竿见影，风险最低
2. **M1（智能截断）** → 独立模块，不影响主循环逻辑
3. **M2（并行决策）** → 替换 shouldParallelize，影响面可控
4. **M4（迭代预算）** → 改动主循环条件，需仔细测试
5. **M5（execute_script）** → 新工具，不影响现有工具
6. **M6（配置调优）** → 最后调参，基于前 5 步的效果

### 风险点

| 风险 | 缓解措施 |
|------|----------|
| 并行 exec 导致竞态 | DESTRUCTIVE_PATTERNS 白名单保守，只有明确只读才并行 |
| execute_script 被滥用 | requiresApproval: true + 脚本长度限制 |
| 溢写文件堆积 | 定期清理 /tmp/geminiclaw-results/（可加 cron） |
| 提示词过长占 token | EXECUTION_BIAS 控制在 500 字以内 |
| 退款机制被利用 | 只有 execute_script 触发退款，且有 cap 兜底 |
