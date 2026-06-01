# GeminiClaw 下一版本整体设计（v3）

> 基于与 Hermes Agent 的能力对比分析，制定 GeminiClaw 下一版本的完整开发设计。
> 本文档追求**最完整、最细致**的整体设计，不以工作量与成本为约束条件。

---

## 0. 对比基线与版本信息（Provenance）

本设计的所有"差距分析"均基于以下精确的代码快照对比，后续追踪 diff 时请以此为锚点。

| 项目 | 仓库 | Commit | 日期 |
|------|------|--------|------|
| **GeminiClaw（本项目）** | 本仓库 | `b4e4d55286de2e92b885c9fbf636fd418ee2623d` | 2026-06-01 |
| **Hermes 对比基线（旧）** | `NousResearch/hermes-agent` | `e527240b2` | 2026-05-03 |
| **Hermes 对比目标（新）** | `NousResearch/hermes-agent` | `cae7537359c0ba8fceedc0a6423a4d9f30972100` | 2026-05-23 |
| 上游运行时参考 | `openclaw/openclaw` | `70d92b5e59df55d6d3d26f2cdb1d6f188182257a` | — |

**Hermes 在基线 `e527240b2` 之后到 `cae7537` 共有 2302 个 commit。** 本文档分析的是这 2302 个 commit 中引入的、GeminiClaw 尚不具备或实现深度不足的能力。

复现对比命令：

```bash
cd ~/Codes/ai/hermes-agent && git fetch
git log e527240b2..cae7537 --oneline          # 查看新增 commit
git rev-list --count e527240b2..cae7537       # 2302
```

> 上一版本设计见 `docs/EVOLUTION-DESIGN-v2.md`（聚焦自进化引擎）。本文档是其在 multi-agent、安全、插件、可靠性维度的全面扩展。

---

## 1. 明确排除项（本版本不做）

经产品决策，以下 Hermes 能力**明确不纳入** GeminiClaw 下一版本：

| 排除项 | 理由 |
|--------|------|
| X / Twitter 搜索 | 与 GeminiClaw 定位无关 |
| 视频生成 / 视频分析 | 非核心场景 |
| 22 个聊天平台适配 | 仅保留 QQBot（已实现），不做泛平台扩展 |
| 国际化（16 语言） | 当前中文场景为主，不需要 |
| Docker / Nix / PyPI 部署 | 部署方式由外部基础设施决定 |

其余 Hermes 新能力，**结合 GeminiClaw 现有功能**进行选择性吸收，见下文。

---

## 2. 能力全景对比（7 大维度）

下表是 GeminiClaw 现状 vs Hermes（`cae7537`）的逐项对比，标注差距等级与本版本决策。

| 维度 | 能力点 | GeminiClaw 现状 | Hermes 现状 | 差距 | 本版本决策 |
|------|--------|------------------|-------------|------|------------|
| **自我进化** | 代码级自改 | ✅ 有（diff+compile+test+行为验证） | ⚠️ 无（只改知识库） | GeminiClaw 领先 | 保持并强化 |
| | 实时对话学习 | ❌ 无 | ✅ background_review（每 turn） | 🔴 重大 | **做：知识进化层** |
| | 知识库整理 | ❌ 无 | ✅ Curator（每 7 天 umbrella 整合） | 🔴 重大 | **做：Curator** |
| | LLM 驱动 intent 评审 | ⚠️ 规则为主 | ✅ rubric prompt 评审 | 🟡 中等 | **做：Intent 评审层** |
| | 成本优化（prefix cache 复用） | ❌ 无 | ✅ fork 继承 cache（-26%） | 🟡 中等 | **做：见 Prompt Cache** |
| **多 Agent** | 任务持久化/状态机 | ❌ 内存 session | ✅ SQLite Kanban | 🔴 重大 | **做：Kanban** |
| | 并发控制 | ⚠️ busy flag | ✅ CAS 乐观锁+WAL+PID | 🔴 重大 | **做：随 Kanban** |
| | Worker 健康检测 | ❌ 无 | ✅ heartbeat+zombie+TTL+熔断 | 🔴 重大 | **做：随 Kanban** |
| | 任务依赖 DAG | ❌ 无 | ✅ task_links+swarm | 🔴 重大 | **做：随 Kanban** |
| | 子 Agent spawn | ⚠️ 仅 DB 行 | ✅ delegate（限工具+深度+超时+中断） | 🟡 中等 | **做：Delegate 运行时** |
| | 持久目标（Ralph Loop） | ❌ 无 | ✅ judge+auto-continue+turn budget | 🔴 重大 | **做：Goals** |
| | 幻觉门控 | ❌ 无 | ✅ created_cards 验证+verifier gate | 🔴 重大 | **做：随 Kanban** |
| | LLM 路由智能度 | ✅ LLM+sticky | ⚠️ 规则调度 | GeminiClaw 领先 | 保持 |
| **安全** | 危险命令审批 | ❌ 无 | ✅ 3 层 blocklist+pattern+tirith | 🔴 重大 | **做：审批层** |
| | Smart Approval（LLM 评估） | ❌ 无 | ✅ approve/deny/escalate | 🔴 重大 | **做：随审批层** |
| | Secret Redaction | ❌ 无 | ✅ 40+ 模式自动脱敏 | 🔴 重大 | **做：脱敏层** |
| | 路径安全（traversal 防护） | ❌ 无 | ✅ validate_within_dir | 🟡 中等 | **做：随安全层** |
| | 审批范围/持久化 | ❌ 无 | ✅ once/session/always+allowlist | 🔴 重大 | **做：随审批层** |
| | Unicode/ANSI 归一化 | ❌ 无 | ✅ NFKC+ANSI strip | 🟡 中等 | **做：随安全层** |
| **可扩展** | Plugin 系统 | ❌ 无 | ✅ 16 hooks+tool override+ctx.llm | 🔴 重大 | **做：Hook+Plugin** |
| | Hook 生命周期 | ⚠️ 硬编码 2 个 | ✅ 16 个事件点 | 🔴 重大 | **做：事件总线** |
| | Tool Override | ❌ 无 | ✅ override=True | 🟡 中等 | **做：随 registry** |
| **代码质量** | LSP 语义诊断 | ⚠️ 仅 tsc（进化时） | ✅ Delta-Baseline 多语言 | 🟡 中等 | **做：LSP 轻量版** |
| **调度** | Cron 定时任务 | ❌ 无 | ✅ once/interval/cron+no_agent+chain | 🟡 中等 | **做：评估后做** |
| | no_agent 模式 | ❌ 无 | ✅ 脚本直跑零 LLM 成本 | 🟡 中等 | **做：随 Cron** |
| **性能/成本** | Prompt Cache | ❌ 无 | ✅ system_and_3（-90% input） | 🟡 中等 | **做：立即做** |
| | 跨会话缓存 | ❌ 无 | ✅ Anthropic ephemeral TTL | 🟡 中等 | **做：随 Prompt Cache** |

**结论速览**：GeminiClaw 在「自我进化的代码修改能力」和「LLM 原生路由」两点领先；但在**多 Agent 可靠性、安全治理、可扩展性、成本优化**四大块存在显著代差。

---

## 3. 重点维度：自我进化实现深度对比（重中之重）

> 用户特别要求：不止看"有没有这个功能"，更要比较两边实现的差异、对方更先进之处。

### 3.1 设计哲学的根本差异

| | GeminiClaw | Hermes |
|--|-----------|--------|
| **进化对象** | 自身**源代码**（TypeScript 文件） | **知识库**（skills 文档 + memory） |
| **比喻** | 自我进化的生物体——代码本身在适应 | 知识管理员——把学到的东西组织好 |
| **粒度** | 文件级 unified diff + 编译 + 测试 | Markdown 文档级 CRUD |
| **风险** | 高（改错代码可致服务崩溃） | 低（改错文档不影响运行时） |
| **验证** | 两级：静态(build+test) + 行为(临时进程重放 trace) | 无（依赖 LLM 判断力） |
| **成熟度** | 功能性原型（已工作，缺深度机制） | 生产级（curator 1782 行，大量 edge case） |

**关键洞察**：两者并非"谁更好"，而是**互补**。GeminiClaw 有 Hermes 完全没有的"真改代码 + 行为验证"能力，这是更难、更危险也更强大的方向。但 Hermes 在"从对话中持续学习"这条**轻量、高频、低风险**的路径上做得极其精细，而 GeminiClaw 完全空白。

### 3.2 Hermes 三层进化机制（GeminiClaw 应补齐前两层）

```
┌─────────────────────────────────────────────────────────┐
│ 第 1 层：Background Review（实时，每 turn）                │
│   触发：每次对话结束 → spawn daemon thread                 │
│   fork：继承父 agent 的 provider/model/cached prompt       │
│        → 命中 Anthropic prefix cache（省 26% 成本）        │
│   工具：白名单仅 memory + skills，其他一律拒绝              │
│   产出：更新 memory（用户偏好）/ 补充 skill                │
│   防护：禁递归、protected skill 不可改、显式排除负面知识    │
├─────────────────────────────────────────────────────────┤
│ 第 2 层：Curator（定期，每 7 天，需空闲 2h）               │
│   做法：prefix clustering → umbrella consolidation        │
│   操作：patch / create / write_file / archive(永不删除)    │
│   产出：run.json + REPORT.md，cron 引用自动重写            │
│   保护：pinned 永不动、bundled/hub-installed 不可编辑      │
│   支持：--dry-run 预览                                     │
├─────────────────────────────────────────────────────────┤
│ 第 3 层：（Hermes 无）代码级进化 ← GeminiClaw 独有且领先   │
└─────────────────────────────────────────────────────────┘
```

### 3.3 GeminiClaw 当前进化引擎流程（已实现，作为第 3 层基础）

```
runOnce():
  IntentEngine 生成意图（TraceAnalyzer + MemoryTopics + UpstreamSync + SkillAnalyzer）
    ↓
  CircuitBreaker 检查（熔断/PROTECTED_PATHS/24h 次数限制）
    ↓
  Mutator：读文件 → LLM 生成 diff → fuzzy apply → tsc 检查 → 失败重试 → git commit
            ↓ 附带 confidence 自评（0-1 + reason + uncertainties）
  Validator：L1 静态(pnpm build + test) → L2 行为(临时进程 + health + trace 重放)
    ↓
  Risk-based 决策：low+验证通过 → auto switch；medium/high → 排队人审
    ↓
  CircuitBreaker 持续监控 failureRate → 超阈值自动 rollback
```

### 3.4 Hermes 比 GeminiClaw 更先进的 8 个具体点

| # | Hermes 先进点 | GeminiClaw 现状 | 借鉴方式 |
|---|--------------|----------------|----------|
| 1 | **知识/代码进化分离**：实时 background + 定期 curator 两条独立链路 | 只有代码进化单链路 | 新增「知识进化层」（第 1+2 层） |
| 2 | **Skill Review Prompt 工程**：精确列出"什么值得存/什么不该存/优先级" | IntentEngine 靠规则，缺 LLM 价值判断 | 给 IntentEngine 加 LLM 评审筛选 |
| 3 | **Umbrella 整合**：prefix 聚类防止 skill 列表膨胀 | skills 会无序膨胀 | 引入 Curator 定期整合 |
| 4 | **负面知识保护**：明列"不应保存"（环境错误/一次性叙事/工具负断言） | 无 anti-pattern 列表 | 给 Mutator 加"不应进化的模式" |
| 5 | **Dry-run 预览**：curator --dry-run 生成报告不实改 | PreviewService 仅雏形 | 完善为「预览 diff→审批→执行」 |
| 6 | **Prefix cache 复用**：fork 继承 cached prompt 省 26% | 每次主模型全量调用 | 进化评审复用 provider + cache |
| 7 | **归档可恢复（absorbed_into）**：永不删除，标记去向 | git branch 天然可回滚但无快照审计 | DB 记录每次进化 before/after 快照 |
| 8 | **分级模型成本**：curator 用 auxiliary 便宜模型 | Mutator 全用主模型 | intent 分级：轻量用 small，复杂用 strong |

### 3.5 本版本进化引擎升级设计

新增 **`src/evolution/knowledge/`** 模块，与现有 `src/evolution/`（代码进化）并列：

```
src/evolution/
├── (现有) intent/ mutator/ validator/ circuit-breaker/   ← 第 3 层：代码进化
└── knowledge/                                            ← 新增
    ├── background-review.ts   ← 第 1 层：每 turn 实时学习
    │     - spawnReview(turnContext): 复用 ProviderRouter + prompt cache
    │     - 白名单工具：仅 memory.write / skill.write
    │     - anti-pattern 过滤器（环境错误/一次性叙事不入库）
    ├── curator.ts             ← 第 2 层：定期知识整理
    │     - 状态转换：stale(30d) / archived(90d)，pinned 豁免
    │     - prefix clustering → umbrella consolidation
    │     - dry-run 模式 + run.json / REPORT.md
    ├── rubric.ts              ← LLM 评审维度（移植 Hermes prompt 工程）
    └── archive-store.ts       ← absorbed_into 归档（永不删除）
```

同时增强现有代码进化层：

- `intent/engine-with-skills.ts`：增加 LLM 评审步骤，对规则生成的 intent 做价值打分与优先排序（借鉴 rubric）。
- `mutator/mutator.ts`：引入 anti-pattern 列表；按 intent 复杂度选择 small/strong 模型。
- `db.ts`：每次进化记录完整 before/after 文件快照，支持审计回溯。

---

## 4. 多 Agent 协作系统设计（Kanban）

### 4.1 目标

将 GeminiClaw 从"内存中 sticky 路由"升级为**可持久化、可恢复、可并发、可监控**的生产级多 Agent 系统，对齐 Hermes Kanban。

### 4.2 数据模型（新增 `src/kanban/`，SQLite WAL）

```
tasks 表：
  id, title, status(triage→todo→scheduled→ready→running→blocked→review→done→archived)
  claim_lock(CAS 乐观锁), claim_expires(TTL), worker_pid
  consecutive_failures, last_heartbeat_at, max_runtime_seconds, current_run_id

task_links 表：parent_id → child_id（DAG 依赖；父全 done 则子 todo→ready 自动提升）
task_runs 表：每次执行历史（outcome: completed/blocked/crashed/timed_out/...）
task_comments 表：Agent 间通信线程（worker spawn 时读取作为上下文）
task_events 表：所有状态变更审计日志
notify_subs 表：completed/blocked 事件回推请求方
```

### 4.3 并发与健康（对齐 Hermes）

- **并发控制**：WAL + `BEGIN IMMEDIATE` + CAS 更新 `status`/`claim_lock`，最多一个 claimer 获胜，losers 观察到 0 行受影响后 move on。
- **Claim TTL**：默认 15 分钟，`heartbeatClaim()` 续期。
- **Zombie 检测**：`releaseStaleClaims()` 每 tick 检查——过期但 PID 存活则延期（避免对慢模型 spawn-then-reclaim 循环），PID 已死则 reclaim + SIGTERM/SIGKILL。
- **熔断**：`consecutive_failures` 达 `failure_limit`（默认 2）自动 block + 附最后错误。

### 4.4 幻觉门控（Hallucination Gate）

- `completeTask()` 验证 worker 声称创建的 `created_cards` 是否真实存在且由该 worker 创建，存在"幽灵卡片"则抛 `HallucinatedCardsError` 拒绝完成。
- Swarm verifier 角色：只有 `metadata.gate === "pass"` 且证据充分才允许 synthesizer 继续。

### 4.5 Swarm 拓扑（结构化协作）

```
planning root (立即 completed)
  ├─ parallel specialist workers (ready)
  └─ verifier (todo until 所有 worker done)
       └─ synthesizer (todo until verifier done)
```

共享黑板通过根任务的结构化 JSON 评论实现，零新服务（复用 task_comments/events）。

### 4.6 Boards（多项目隔离，可选）

每 board 独立 SQLite DB + 独立 workspace/logs，worker 通过环境变量限制在单 board，无法枚举其他 board。

### 4.7 与现有 Dispatcher 的关系

保留现有 `src/guidance/dispatcher.ts` 的 **LLM 路由**（GeminiClaw 领先项），将其作为"入口路由层"；Kanban 作为"任务持久化与执行层"。两者分工：Dispatcher 决定"谁来处理"，Kanban 负责"任务怎么持久化执行与交接"。

---

## 5. 子 Agent 委托运行时（Delegate）

升级 `src/agents/repository.ts` 从"仅写 DB 行"到完整运行时（新增 `src/agents/delegate.ts`）：

- 每个子 Agent：新对话（无父历史）、独立 task_id、受限工具集、聚焦 system prompt。
- **禁用工具**：`delegate`（禁递归）、`clarify`、`memory`、`send_message`、`execute_code`。
- **深度限制**：默认 `MAX_DEPTH=1`，可配最大 3。
- **并发**：`max_concurrent_children` 默认 3。
- **超时**：`child_timeout_seconds` 默认 600s。
- **Orchestrator 角色**：保留委托工具集，允许嵌套。
- **暂停/中断**：`setSpawnPaused()` + `interruptSubagent()`。
- **审批回调**：子 Agent 安装非交互回调，默认 auto-deny 危险命令。

---

## 6. 持久目标系统（Goals / Ralph Loop）

新增 `src/goals/`：

- `GoalState`：goal 文本、status(active/paused/done/cleared)、turns_used、max_turns(默认 20)、subgoals[]。
- **Judge 循环**：每轮结束调辅助 LLM 判断目标是否满足，返回 `{done, reason}`。
- **自动续行**：未完成则生成 continuation prompt 注入会话。
- **保护**：judge 连续 3 次不可解析则自动暂停；用户新消息到达自动暂停。
- **持久化**：存 SessionDB 的 state_meta，支持 `/resume`。
- **Subgoals**：运行期 `/subgoal` 追加条件。

---

## 7. 安全治理层（全新，🔴 当前完全空白）

新增 `src/security/`，这是 GeminiClaw 最薄弱、最需补齐的板块。

### 7.1 命令审批（三层防线）

```
┌────────────────────────────────────────────────┐
│ Layer 1 Hardline Blocklist（无条件拒绝）          │
│   rm -rf /, mkfs, dd→block device, fork bomb,    │
│   shutdown/reboot, kill -1, sudo -S 密码猜测      │
├────────────────────────────────────────────────┤
│ Layer 2 Dangerous Patterns（~47 正则，需审批）    │
│   递归删除, chmod 777, SQL DROP/DELETE/TRUNCATE,  │
│   git force push / reset --hard, curl|sh,        │
│   tee 到系统文件, shell -c                        │
├────────────────────────────────────────────────┤
│ Layer 3 Smart Approval（辅助 LLM 风险评估）       │
│   approve / deny / escalate 三级，低风险自动通过   │
└────────────────────────────────────────────────┘
```

### 7.2 审批交互与持久化

- **队列式审批**：`ApprovalEntry` + Promise/Event + 每 session FIFO 队列，支持并发子 agent。
- **QQBot 集成**：复用已实现的 InlineKeyboard（`buildApprovalKeyboard`）在 QQ 页面弹确认框，`INTERACTION_CREATE` 回调路由到审批决策。
- **审批范围**：once / session / always + 持久 allowlist（写 config.yaml `command_allowlist`）。
- **Cron 模式**：`approvals.cron_mode` = deny | approve。
- **超时处理**：审批超时默认 deny。

### 7.3 Secret Redaction（`src/security/redaction.ts`）

- 40+ 正则：OpenAI `sk-`、GitHub `ghp_`、AWS `AKIA`、DB connection strings、JWT、`Authorization` headers、env 赋值、手机号/Discord token。
- 结构化识别：JSON / URL / JWT 内嵌密钥。
- **应用面**：所有日志、tool 输出、trace 写入前统一过脱敏管道，防止密钥进入 EvolutionDB / SessionDB / 日志文件。

### 7.4 输入归一化与路径安全

- **Unicode NFKC 归一化**：`normalizeCommandForDetection()` 防止全角字符绕过 blocklist。
- **ANSI strip**：去除转义序列防止隐藏字符绕过。
- **路径安全**：`validateWithinDir()` + `..` traversal 检测，防止文件操作逃逸工作区（与现有 workspace_rules 协同）。

### 7.5 容器/隔离边界

- 在 docker / 沙箱环境中可跳过审批（环境隔离即安全边界），由 config 控制。
- MCP 子进程凭证过滤：不继承敏感环境变量。

---

## 8. 可扩展性：事件总线 + Plugin 系统

### 8.1 事件 Hook 总线（`src/hooks/`）

将现有 `AgentLoop` 硬编码的 2 个回调（`beforeToolCall`/`afterToolCall`）泛化为 EventEmitter 事件总线，对齐 Hermes 的生命周期点：

```
pre_tool_call / post_tool_call
pre_llm_call  / post_llm_call
on_session_start / on_session_end / on_session_reset
subagent_stop
pre_gateway_dispatch
```

支持 glob 匹配事件名、`emit()` 异步广播、`emitCollect()` 收集 handler 返回值。

### 8.2 Plugin 加载器（`src/plugins/`）

```
发现来源（优先级递增，后者覆盖前者）：
  bundled(<repo>/plugins/) → user(~/.geminiclaw/plugins/)
  → project(.geminiclaw/plugins/)

每个 plugin export register(ctx: PluginContext)，ctx 暴露：
  ctx.registerTool(name, toolset, schema, handler, {override})
  ctx.registerHook(hookName, callback)
  ctx.registerCommand(name, handler, description)
  ctx.registerSkill(name, path)
  ctx.llm.chat(...) / ctx.llm.chatStructured(...)   ← 借用宿主 ProviderRouter
  ctx.injectMessage(content, role)
  ctx.dispatchTool(name, args)

plugin.yaml manifest：name / version / description / requiresEnv[]
```

### 8.3 Tool Override

`registry.register()` 增加 `override?: boolean`，后注册者覆盖同名内建工具，按发现优先级排序。

---

## 9. 代码质量：LSP 语义诊断

### 9.1 轻量版（先做，80% 收益）

在事件总线 `post_tool_call` 钩子中，检测 `write_file`/`patch` 完成后对 `.ts` 文件执行 `tsc --noEmit`，将新增 type error 追加到 tool result，让 LLM 自动修复。

### 9.2 完整版（长期）

新增 `src/lsp/`，用 `vscode-languageserver-protocol` 与 LSP server 通信：

- **Delta-Baseline 模式（必须借鉴）**：写前 `snapshotBaseline(file)` → 写后 `getDiagnostics(file)` → 只返回**新增**诊断（diff），避免"修一个错产生十个旧错"的循环。
- 语言映射表：起步 TypeScript（ts-server）+ Python（pyright），按需扩展。
- 输出格式：`<diagnostics file="...">` 块，默认仅 ERROR、每文件 ≤20 条。

---

## 10. 调度：Cron 定时任务（需定位决策）

### 10.1 定位决策

- 若 GeminiClaw 定位为「被 CatDesk automation 调度的后端」→ **不自建 cron**，由 CatDesk RRULE 调度。
- 若定位为「独立 agent runtime」→ 自建（见下）。

### 10.2 设计（若自建，`src/cron/`）

- 存储：SQLite（避免 JSON 并发写冲突）。
- Schedule：`once`（`30m`/`2h`/绝对时间）/ `interval`（`every 5m`）/ `cron`（`0 9 * * *`，croniter 解析）。
- **no_agent 模式**：不启 LLM，直接 subprocess 跑 script，stdout 即结果；空 stdout = 静默；非零退出 = 告警。零成本 watchdog。
- **context_from 链式注入**：Job B 读取 Job A 最近输出 prepend 到 prompt，支持多级 pipeline。
- Tick：60s 轮询 + 文件锁防并发；有 workdir/profile 的任务串行，其余并行。

---

## 11. 性能/成本：Prompt Cache（立即做，ROI 最高）

### 11.1 实现

移植 Hermes `prompt_caching.py`（~80 行纯函数）到 TypeScript，在 Anthropic provider 的 `chat()`/`stream()` 调用前处理 messages：

- **策略 `system_and_3`**：在 system prompt + 最后 3 条消息位置注入 `cache_control: {type: "ephemeral"}` breakpoint。
- TTL：5 分钟（默认）或 1 小时，由 Anthropic 服务端控制。
- 纯函数、无状态。

### 11.2 收益与适配

- 对长 system prompt 可节省 ~90% input token 费用。
- 进化引擎的 background-review fork 复用同一 cached prompt（对齐 Hermes -26% 成本）。
- 仅 Anthropic 生效（OpenAI prefix caching 自动），做成可配置策略 `system_only / system_and_N`。

---

## 12. 实施路线图（按 ROI 与依赖排序）

> 不以工作量为约束，但仍按"依赖关系 + 风险 + 收益"给出建议顺序。

### 阶段一：低成本高收益 + 安全底座（基础设施）

1. **Prompt Cache**（极低成本，立即省钱）。
2. **事件 Hook 总线**（解锁后续插件/LSP/安全钩子的基础）。
3. **安全治理层**（命令审批三层 + Secret Redaction + 路径安全）——当前完全空白，最高优先级补齐，复用已实现的 QQBot InlineKeyboard 做审批交互。
4. **LSP 轻量版**（write 后 tsc，挂在 post_tool_call）。

### 阶段二：进化引擎深度补齐

5. **知识进化层**：background-review（实时学习）+ rubric（评审 prompt）+ anti-pattern 过滤。
6. **Curator**：定期 umbrella 整合 + dry-run + archive 永不删除。
7. 增强代码进化层：intent LLM 评审、分级模型成本、before/after 快照审计。

### 阶段三：生产级多 Agent

8. **Kanban**（SQLite 状态机 + CAS 并发 + heartbeat/zombie + 熔断 + 幻觉门控）。
9. **Delegate 运行时**（工具限制 + 深度 + 超时 + 中断）。
10. **Swarm 拓扑**（verifier gate + 黑板）。
11. **Goals / Ralph Loop**（持久目标 + judge + auto-continue）。

### 阶段四：生态与可选项

12. **Plugin 加载器 + Tool Override + ctx.llm**。
13. **LSP 完整版**（Delta-Baseline 多语言）。
14. **Cron**（依定位决策；含 no_agent + context_from）。
15. **Boards 多项目隔离**（可选）。

---

## 13. 模块落点总览（目录设计）

```
src/
├── agent/              （现有）AgentLoop → 升级：beforeToolCall/afterToolCall 改为事件总线
├── evolution/          （现有）代码进化第 3 层
│   ├── intent/         → 增加 LLM 评审筛选
│   ├── mutator/        → anti-pattern + 分级模型
│   ├── validator/
│   ├── circuit-breaker/
│   ├── db.ts           → before/after 快照审计
│   └── knowledge/      ★新增：进化第 1+2 层
│       ├── background-review.ts
│       ├── curator.ts
│       ├── rubric.ts
│       └── archive-store.ts
├── kanban/             ★新增：任务状态机 + 并发 + 健康 + swarm
├── agents/
│   ├── repository.ts   （现有）
│   └── delegate.ts     ★新增：子 agent 运行时
├── goals/              ★新增：Ralph Loop 持久目标
├── security/           ★新增：审批 + redaction + 路径安全 + 归一化
│   ├── approval.ts
│   ├── blocklist.ts
│   ├── patterns.ts
│   ├── smart-approval.ts
│   ├── redaction.ts
│   └── path-security.ts
├── hooks/              ★新增：事件总线（16 生命周期点）
├── plugins/            ★新增：加载器 + PluginContext + manifest
├── lsp/                ★新增：Delta-Baseline 诊断（含轻量版）
├── cron/               ★新增（依定位）：调度 + no_agent + context_from
├── prompt-cache/       ★新增：system_and_3 缓存标记
├── channels/qqbot/     （现有）复用 InlineKeyboard 做安全审批交互
├── guidance/dispatcher.ts （现有）保留 LLM 路由，作为 Kanban 入口层
├── providers/ memory/ config/ server/  （现有）
```

---

## 14. 风险与权衡

| 风险 | 说明 | 缓解 |
|------|------|------|
| 范围过大 | 本设计覆盖 7 大维度，一次性全做风险高 | 严格按阶段一→四推进，每阶段独立可交付 |
| 进化引擎改坏自身 | 代码级进化危险 | 保持 PROTECTED_PATHS 保护 evolution/security/config 本身 |
| 多 Agent 复杂度 | Kanban 引入 SQLite/进程管理 | 保留单进程轻量优势，Kanban 为可选启用模块 |
| 安全审批阻塞体验 | 过度审批影响流畅度 | Smart Approval 低风险自动通过 + allowlist 记忆 |
| TypeScript vs Python 移植 | Hermes 是 Python，直译有坑 | LSP/Plugin 用 TS 原生生态（vscode-lsp、动态 import）重写而非直译 |

---

## 15. 与上一版本设计的衔接

- `docs/EVOLUTION-DESIGN-v2.md`：聚焦自进化引擎（第 3 层代码进化），是本文档第 3 章的前置。
- 本文档（v3）：在保留并强化代码进化的基础上，**横向扩展**到知识进化、多 Agent、安全、可扩展性、成本五大维度，构成 GeminiClaw 下一版本的完整蓝图。

---

*文档生成时间锚点：GeminiClaw `b4e4d55` / Hermes `cae7537`（基线 `e527240b2` 起 2302 commit）。后续追踪 Hermes 新能力时，请更新第 0 章的对比目标 commit。*
