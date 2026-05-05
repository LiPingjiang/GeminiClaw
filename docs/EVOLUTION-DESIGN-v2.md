# GeminiClaw Evolution Engine — Design v2

> **状态：** 设计稿，待实现
> **作者：** 李平江 + 观澜
> **日期：** 2026-05-05
> **基于：** GeminiClaw v0.2.1（`~/Codes/GeminiClaw`）

---

## 一、参考基线（Reference Commits）

记录本次设计所参考的上游版本。下次开发前，只需对比各仓库最新 commit 与此基线之间的 diff，
无需全量扫描。

| 仓库 | 用途 | 参考 Commit |
|------|------|-------------|
| `openclaw/openclaw` | 上游运行时，参考架构、hook 机制、memory 系统 | `70d92b5e59df55d6d3d26f2cdb1d6f188182257a` |
| `LiPingjiang/GeminiClaw` (GeminiClaw2，`gemini/main` 分支) | Phase 1-5 原型实现，参考模块边界和流程设计 | `8b3957cca1` |
| `NousResearch/hermes-agent` | 参考 Curator、Lifecycle、Rubric-based 评分、Pin 机制 | `e527240b2` |

**下次同步检查命令：**
```bash
# OpenClaw 上游新增了什么
gh api /repos/openclaw/openclaw/compare/70d92b5e59df55d6d3d26f2cdb1d6f188182257a...HEAD --jq '.commits[].commit.message' 2>/dev/null

# Hermes 上游新增了什么
cd ~/Codes/ai/hermes-agent && git fetch && git log e527240b2..HEAD --oneline
```

---

## 二、为什么重新设计

GeminiClaw2（`gemini/` 目录）的 Phase 1-5 实现是"边跑边造"的产物，有以下根本性问题：

### 问题 1：Mutator 硬依赖外部 `mc` 命令
- `spawn("mc", ["--code", ...])` 在 standby slot 执行，`mc` 不在 PATH 就直接失败
- mc --code 进程是孤儿风险（OpenClaw #77720：parent 死亡时 subagent 无终止信号）
- 每次调用都是无状态的，无法续接失败的改动
- `mc` 本身也可能进化，产生循环依赖

### 问题 2：行为验证用 Jaccard 相似度是伪科学
- LLM 天然有随机性（temperature > 0），同一问题两次输出词集合差异可达 30%+
- "词集合相似"≠"语义等价"，更好的回答可能词汇差异更大
- 5 条 trace 样本统计意义不足

### 问题 3：JSON 文件无锁读写
- OpenClaw #77783：`sessions.json` 出现过 0 字节损坏
- IntentStore、CircuitBreaker、TraceStore 并发读写同一目录无保护

### 问题 4：Slot 初始化是手动的
- VOYAGE_LOG 明确写：「standby slot 需要手动 cp -r 或 git worktree」
- slot-b 的 `node_modules` 需要单独 `pnpm install`，依赖版本可能漂移

### 问题 5：Evolution Engine 与记忆系统割裂
- Intent 生成只看原始 trace，不读 layered memory topics
- GeminiClaw 已有 4 层 topics 记忆，但 Evolution Engine 完全没利用

### 问题 6：冷启动期 Intent 生成为空
- 新部署 trace 为空，IntentEngine 什么都分析不出来
- 没有 bootstrap 机制，系统上线后要等很久才能开始进化

### 问题 7：UpstreamSync 需要用户手动贴 prompt
- cron 只存 prompt，用户要手动贴给 LLM 再把结果粘回来
- 体验割裂，不像一个自进化系统

---

## 三、核心设计原则（v2）

1. **SQLite first**：所有持久化状态统一进 `.gemini-data/gemini.db`，不散落 JSON 文件
2. **Mutator 内化**：通过 GeminiClaw 自己的 provider 层调用 LLM 做代码修改，不依赖外部命令；`mc --code` 作为可选加速后端
3. **结构化断言验证**：不比较文本，比较工具调用序列、响应结构、关键字段
4. **Slot 自动 bootstrap**：`git worktree` 自动创建 slot-b，依赖自动安装
5. **记忆与进化打通**：Intent 生成时读取 layered memory topics，不只看原始 trace
6. **Bootstrap intents 预置**：冷启动时有已知优化点（启动速度、prompt cache、记忆质量等）
7. **人在回路，渐进自动化**：low-risk 自动，medium 等手动确认，high 等人工审核

---

## 四、整体架构

```
GeminiClaw/
├── src/
│   ├── server/           ← Fastify HTTP server（已有）
│   ├── providers/        ← LLM provider 适配层（已有）
│   ├── memory/           ← 分层记忆系统（已有）
│   ├── config/           ← 配置加载（已有）
│   │
│   └── evolution/        ← Evolution Engine（v2，新建）
│       ├── index.ts      ← EvolutionEngine 主类，Gateway 启动时初始化
│       ├── types.ts      ← 共享类型定义
│       ├── db.ts         ← SQLite 数据层（单文件，统一所有持久化）
│       │
│       ├── trace/        ← TraceCollector：收集对话事件
│       ├── intent/       ← IntentEngine：生成进化意图（三来源）
│       ├── mutator/      ← Mutator：在 standby slot 改代码
│       ├── validator/    ← Validator：三级验证
│       ├── switcher/     ← Switcher：槽位切换 + 状态迁移
│       ├── circuit-breaker/ ← CircuitBreaker：熔断 + 自动回滚
│       └── bootstrap/    ← BootstrapIntents：冷启动预置意图
│
├── slots/                ← 运行时槽位（gitignore）
│   ├── slot-a/           ← git worktree，槽位 A
│   ├── slot-b/           ← git worktree，槽位 B
│   ├── active -> slot-a/ ← 软链接，当前运行态
│   └── standby -> slot-b/← 软链接，当前待机态
│
└── .gemini-data/
    └── gemini.db         ← 单一 SQLite 文件，所有状态
```

---

## 五、数据层设计（SQLite）

所有持久化状态统一进 `gemini.db`，用 better-sqlite3（同步 API，无回调地狱）。

### 5.1 表结构

```sql
-- 进化意图
CREATE TABLE intents (
  id          TEXT PRIMARY KEY,
  type        TEXT NOT NULL,   -- behavior_fix | new_feature | upstream_sync | performance | bootstrap
  description TEXT NOT NULL,
  target_files TEXT NOT NULL,  -- JSON array
  evidence    TEXT NOT NULL,   -- JSON array
  risk_level  TEXT NOT NULL,   -- low | medium | high
  requires_human_approval INTEGER NOT NULL DEFAULT 0,
  status      TEXT NOT NULL,   -- pending | in_progress | validating | approved | rejected | applied | rolled_back
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

-- 对话 trace（轻量索引，不存全文）
CREATE TABLE traces (
  id          TEXT PRIMARY KEY,
  session_id  TEXT NOT NULL,
  tool_sequence TEXT,          -- JSON array，工具调用顺序
  had_failure INTEGER NOT NULL DEFAULT 0,
  message_count INTEGER NOT NULL DEFAULT 0,
  recorded_at INTEGER NOT NULL
);

-- 进化历史
CREATE TABLE evolution_history (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  intent_id   TEXT NOT NULL,
  type        TEXT NOT NULL,   -- switch | rollback
  from_slot   TEXT NOT NULL,
  to_slot     TEXT NOT NULL,
  changed_files TEXT NOT NULL, -- JSON array
  recorded_at INTEGER NOT NULL
);

-- 槽位状态
CREATE TABLE slot_state (
  slot_id     TEXT PRIMARY KEY, -- a | b
  role        TEXT NOT NULL,    -- active | standby
  build_hash  TEXT NOT NULL DEFAULT '',
  built_at    INTEGER NOT NULL DEFAULT 0,
  last_activated_at INTEGER
);

-- 上游检查记录
CREATE TABLE upstream_checks (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  new_commits TEXT NOT NULL,   -- JSON array
  changed_files TEXT NOT NULL, -- JSON array
  added_lines INTEGER NOT NULL DEFAULT 0,
  removed_lines INTEGER NOT NULL DEFAULT 0,
  checked_at  INTEGER NOT NULL,
  intent_generated INTEGER NOT NULL DEFAULT 0
);

-- 人工审核队列
CREATE TABLE pending_reviews (
  intent_id   TEXT PRIMARY KEY,
  description TEXT NOT NULL,
  target_files TEXT NOT NULL,  -- JSON array
  risk_level  TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending', -- pending | approved | rejected
  reviewer    TEXT,
  comment     TEXT,
  requested_at INTEGER NOT NULL,
  resolved_at  INTEGER
);
```

### 5.2 数据层接口

```typescript
// src/evolution/db.ts
export class EvolutionDB {
  constructor(dbPath: string)

  // Intents
  saveIntent(intent: Intent): void
  getIntent(id: string): Intent | null
  listIntents(status?: IntentStatus): Intent[]
  updateIntent(id: string, patch: Partial<Intent>): void

  // Traces
  saveTrace(trace: TraceRecord): void
  listRecentTraces(limit: number): TraceRecord[]
  getFailureRate(windowMs: number): number  // 最近 N ms 内的失败率

  // Evolution history
  recordEvolution(record: EvolutionRecord): void
  getRecentHistory(limit: number): EvolutionRecord[]
  getEvolutionCountForFile(file: string, windowMs: number): number  // 频率限制用

  // Slot state
  getSlotState(slotId: SlotId): SlotState
  updateSlotState(slotId: SlotId, patch: Partial<SlotState>): void
  swapSlotRoles(): void  // 原子交换 active/standby

  // Upstream checks
  saveUpstreamCheck(check: UpstreamCheckRecord): void
  getLatestUpstreamCheck(): UpstreamCheckRecord | null

  // Human review
  addPendingReview(review: PendingReview): void
  resolvePendingReview(intentId: string, status: 'approved' | 'rejected', reviewer: string, comment?: string): void
  getPendingReviews(): PendingReview[]
}
```

---

## 六、模块设计

### 6.1 TraceCollector（重构）

**改动点：** 不再写 JSONL 文件，改为写 SQLite traces 表。只存轻量索引（工具序列、失败标志、消息数），不存全文——全文已在 OpenClaw session store（JSONL）里，不重复存储。

```typescript
// src/evolution/trace/collector.ts
export class TraceCollector {
  // 挂在 server 的 chat 路由上，每次对话结束后记录
  // 不再 monkey-patch hookRunner（GeminiClaw 没有 OpenClaw 的 hookRunner）
  // 改为：chat route 完成后直接调用 collector.record()

  record(sessionId: string, toolSequence: string[], hadFailure: boolean, messageCount: number): void
  getRecentFailureRate(windowMs: number): number
}
```

**关键变化：** GeminiClaw 是干净版，没有 OpenClaw 的 hookRunner，直接在 chat route 里调用，更简单。

### 6.2 IntentEngine（重构）

**三个意图来源，全部接通：**

```typescript
// src/evolution/intent/engine.ts
export class IntentEngine {
  // 来源 1：trace 分析（失败率高的工具序列 → behavior_fix）
  private analyzeTraces(): Intent[]

  // 来源 2：memory topics 分析（高频但质量低的 topic → 记忆优化意图）
  private analyzeMemoryTopics(): Intent[]   // ← v2 新增，打通记忆系统

  // 来源 3：上游 diff（UpstreamSyncSource 生成）
  private analyzeUpstream(): Promise<Intent[]>

  // 合并去重，按 riskLevel 排序，存入 DB
  async generateIntents(): Promise<number>
}
```

**Memory topics 分析逻辑：**
- 读取 `src/memory/` 的 layered topics（L0 索引）
- 找出：token 超过阈值但 L1 摘要质量低的 topic → 生成 `performance` 类意图（压缩优化）
- 找出：被频繁查询但总是返回 L3 详情的 topic → 生成 `new_feature` 意图（提升 L1/L2 摘要质量）

### 6.3 Mutator（重构，核心改动）

**不再依赖 `mc --code`，改为内置 LLM 调用：**

```typescript
// src/evolution/mutator/mutator.ts
export class Mutator {
  // 主路径：通过 GeminiClaw 自己的 ProviderRouter 调用 LLM
  // 用 agentic loop：LLM 读文件 → 生成 patch → 写文件 → 验证语法
  async mutate(intent: Intent, slotDir: string): Promise<MutationResult>

  // 可选加速：如果 mc 在 PATH 里，用 mc --code（更强的 coding agent）
  // 失败时自动降级到内置 LLM 路径
  private async mutateWithMc(intent: Intent, slotDir: string): Promise<MutationResult>
  private async mutateWithBuiltinLLM(intent: Intent, slotDir: string): Promise<MutationResult>
}
```

**内置 LLM 改代码的 agentic loop：**
```
1. 读取 targetFiles 内容
2. 构造 prompt（intent.description + 文件内容 + 修改要求）
3. LLM 输出 unified diff 格式的变更
4. 应用 diff（用 Node.js 内置能力，不依赖 patch 命令）
5. TypeScript 语法检查（tsc --noEmit 单文件）
6. 如果语法错误，把错误信息反馈给 LLM，最多重试 3 次
7. git commit
```

**进程管理：** 使用 AbortController 控制超时，进程退出时清理子进程，解决孤儿进程问题。

### 6.4 Validator（重构）

**Level 1：静态检查（不变，但更快）**
```
pnpm build（tsc，超时 3 分钟）
pnpm test（vitest，只跑 changed files，超时 5 分钟）
```

**Level 2：结构化断言（替换 Jaccard 相似度）**

不再比较文本，改为比较**结构化行为特征**：
```typescript
type BehaviorAssertion = {
  // 工具调用序列是否匹配（允许顺序变化，不允许缺失关键工具）
  toolSequenceMatch: boolean
  // 响应是否包含必要字段（JSON 结构断言）
  structureMatch: boolean
  // 响应长度是否在合理范围（防止退化为空响应或超长输出）
  lengthInRange: boolean
  // 错误率（slot-B 在隔离端口跑 10 个请求，统计 5xx 比例）
  errorRate: number
}
```

**Level 3：人工审核（不变）**
- 写入 `pending_reviews` 表
- 通过 GeminiClaw 的 chat API 推送通知（不需要外部渠道）

### 6.5 Switcher（改进）

**Slot 自动 bootstrap（解决手动初始化问题）：**

```typescript
export class Switcher {
  // 初始化时检查 slot-b 是否存在，不存在则自动创建
  async ensureSlots(): Promise<void> {
    // 用 git worktree add slots/slot-b HEAD 创建 slot-b
    // 在 slot-b 里运行 pnpm install
    // 初始化 slot_state 表
  }

  // 切换：更新软链接 + 原子交换 DB 里的 slot role
  async switch(): Promise<SwitchResult>

  // 回滚：反向切换，从 evolution_history 找上一次切换记录
  async rollback(): Promise<SwitchResult>
}
```

### 6.6 CircuitBreaker（改进）

**监控改为基于真实对话质量，而不是 `/health` 存活：**

```typescript
export class CircuitBreaker {
  // 切换后开始监控
  startMonitoring(switchResult: SwitchResult): void

  // 每 30 秒检查：
  // 1. 错误率（从 DB traces 表读最近 5 分钟）
  // 2. 平均响应时间（从 DB 读）
  // 如果错误率 > 阈值 OR 响应时间 > 2x 基准，触发回滚
  private async checkHealth(): Promise<HealthMetrics>

  // 保护规则：
  // - circuit open → 拒绝所有进化
  // - 同一文件 24h 内超过 3 次 → 拒绝
  // - PROTECTED_PATHS（evolution/ 目录）→ 拒绝
  canEvolve(targetFiles: string[]): { allowed: boolean; reason?: string }
}
```

### 6.7 BootstrapIntents（新增）

冷启动时预置已知优化点，让系统上线就有事可做：

```typescript
// src/evolution/bootstrap/intents.ts
export const BOOTSTRAP_INTENTS: Intent[] = [
  {
    type: 'performance',
    description: '在消息历史的最近 3 条上打 cache_control: ephemeral，提升 prompt cache 命中率',
    targetFiles: ['src/providers/anthropic.ts', 'src/providers/mcli.ts'],
    riskLevel: 'low',
    // 来源：INSIGHTS.md 二、Prompt Cache 命中率
  },
  {
    type: 'performance',
    description: '启动时并行初始化 provider（现在是串行），减少冷启动时间',
    targetFiles: ['src/index.ts'],
    riskLevel: 'low',
    // 来源：INSIGHTS.md 一、启动速度
  },
  {
    type: 'behavior_fix',
    description: '当 LLM provider 返回空 content 时，记录详细错误而不是静默失败',
    targetFiles: ['src/providers/router.ts'],
    riskLevel: 'low',
  },
]
```

### 6.8 UpstreamSyncSource（改进）

**不再需要用户手动贴 prompt，改为直接调用 LLM：**

```typescript
export class UpstreamSyncSource {
  async checkAndGenerateIntents(): Promise<Intent[]> {
    const diff = await this.fetchUpstreamDiff()
    if (diff.newCommits.length === 0) return []

    // 直接调用 GeminiClaw 的 provider（轻量模型，如 gemini-flash）
    const analysis = await this.provider.chat([{
      role: 'user',
      content: this.buildSyncPrompt(diff)
    }])

    return this.parseIntents(analysis.content, diff)
  }
}
```

---

## 七、EvolutionEngine 主类接口

```typescript
// src/evolution/index.ts
export class EvolutionEngine {
  constructor(params: {
    db: EvolutionDB
    providerRouter: ProviderRouter    // 复用 GeminiClaw 已有的 provider 层
    memoryContext: MemoryContext      // 复用 GeminiClaw 已有的记忆系统
    repoRoot: string
    config?: Partial<EvolutionConfig>
    logger?: Logger
  })

  // 生命周期
  async start(): Promise<void>   // 初始化 slots，加载 bootstrap intents，启动 trace 收集
  async stop(): Promise<void>

  // 核心流程
  async runOnce(): Promise<RunOnceResult>     // 一次完整进化周期
  async manualSwitch(): Promise<SwitchResult> // 手动切换（medium-risk 等待）
  async approveIntent(intentId: string, reviewer: string): Promise<void>  // 人工审核通过
  async checkUpstream(): Promise<UpstreamCheckResult>  // 手动触发上游检查

  // 状态查询（供 CLI / HTTP API 使用）
  async getStatus(): Promise<EvolutionStatus>
  async getHistory(limit?: number): Promise<EvolutionRecord[]>

  // TraceCollector 暴露给 chat route 调用
  getTraceCollector(): TraceCollector
}
```

---

## 八、与现有 GeminiClaw 的集成点

只需改动两个文件：

**`src/index.ts`（启动时初始化）：**
```typescript
import { EvolutionEngine } from './evolution/index.js'

const evolution = new EvolutionEngine({
  db: new EvolutionDB(config.dataDir + '/gemini.db'),
  providerRouter,    // 已有
  memoryContext,     // 已有
  repoRoot: process.cwd(),
  config: config.evolution,
})
await evolution.start()
```

**`src/server/routes/chat.ts`（记录 trace）：**
```typescript
// 对话完成后，异步记录（不阻塞响应）
setImmediate(() => {
  evolution.getTraceCollector().record(sessionId, toolSequence, hadFailure, messageCount)
})
```

新增一个 HTTP 端点（可选，供 CLI 调用）：
```
GET  /v1/evolution/status       — 查看进化引擎状态
POST /v1/evolution/run          — 手动触发一次进化周期
POST /v1/evolution/switch       — 手动切换槽位
POST /v1/evolution/approve/:id  — 批准高风险意图
GET  /v1/evolution/history      — 查看进化历史
```

---

## 九、实施路线（分阶段）

### Phase A：基础设施（1-2天）
- [ ] `src/evolution/types.ts` — 类型定义
- [ ] `src/evolution/db.ts` — SQLite 数据层
- [ ] `src/evolution/trace/collector.ts` — TraceCollector（写 DB）
- [ ] `src/evolution/bootstrap/intents.ts` — 预置意图
- [ ] `src/evolution/index.ts` 骨架

### Phase B：手动进化闭环（2-3天）
- [ ] `src/evolution/mutator/mutator.ts` — 内置 LLM + mc 降级
- [ ] `src/evolution/validator/validator.ts` — Level 1 静态检查
- [ ] `src/evolution/switcher/switcher.ts` — Slot 自动 bootstrap + 切换
- [ ] 手动跑通一次完整进化演练

### Phase C：自动化验证（1-2天）
- [ ] Validator Level 2 — 结构化断言
- [ ] `src/evolution/circuit-breaker/circuit-breaker.ts` — 基于 trace 质量的监控
- [ ] low-risk 自动切换接通

### Phase D：意图质量提升（1-2天）
- [ ] IntentEngine 接通 memory topics 分析
- [ ] BootstrapIntents 扩充（基于 INSIGHTS.md）
- [ ] UpstreamSyncSource 接通内置 LLM

### Phase E：CLI + HTTP API（1天）
- [ ] `/v1/evolution/*` 端点
- [ ] Validator Level 3 人工审核流程

---

## 十、受保护文件（不参与自动进化）

```typescript
export const PROTECTED_PATHS = [
  'src/evolution/',     // 进化引擎自身
  'src/config/',        // 配置加载
  'gemini.db',          // 数据库文件
  'slots/',             // 槽位目录
  '.gemini-data/',      // 数据目录
]
```

---

## 十一、开放问题（待决策）

1. **Mutator 内置 LLM 的 agentic loop 深度**：最多几轮？每轮 retry 成本多少？
2. **Level 2 验证的请求数量**：10 个请求够不够？怎么选取测试用例？
3. **bootstrap intents 的触发条件**：只在 trace 为空时触发，还是始终保留在队列里？
4. **slot-b 的 git worktree 策略**：用同一 branch 还是新建 `gemini/standby` branch？
5. **UpstreamSyncSource 用哪个 provider**：轻量模型（gemini-flash）还是主模型？
