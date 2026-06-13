# GeminiClaw 架构设计

> 核心理念：**自我进化的 AI 运行时**
> 
> 不是在沙盒里改配置，而是真正修改自己的代码、验证、部署。

---

## 一、为什么叫 Gemini（双子）

GeminiClaw 是 OpenClaw 的 fork，采用 **Twin-System（双槽位）架构**：

- 系统始终有两个槽位：**slot-A（运行态）** 和 **slot-B（待机态）**
- 运行中的 slot-A 可以修改 slot-B 的代码
- 测试通过后，两个槽位互换角色
- 如此循环，系统不断进化，且始终有一个稳定的回退点

这不是热补丁，不是插件热重载——是**整个运行时的自我迭代**。

---

## 二、整体架构

```
GeminiClaw/
├── slot-a/                  ← 槽位 A（源码 + 构建产物）
│   ├── src/                 ← TypeScript 源码
│   ├── dist/                ← 编译产物
│   └── package.json
│
├── slot-b/                  ← 槽位 B（源码 + 构建产物）
│   ├── src/
│   ├── dist/
│   └── package.json
│
├── active -> slot-a/        ← 软链接，指向当前运行态
├── standby -> slot-b/       ← 软链接，指向当前待机态
│
├── evolution/               ← 进化引擎（核心）
│   ├── intent/              ← 意图层：从哪里发现"该改什么"
│   ├── mutator/             ← 变异层：生成代码变更
│   ├── validator/           ← 验证层：测试变更是否安全
│   ├── switcher/            ← 切换层：执行槽位互换
│   └── circuit-breaker/     ← 熔断层：防止进化跑偏
│
├── state/                   ← 共享状态（跨槽位持久化）
│   ├── sessions/
│   ├── memory/
│   └── traces/
│
└── gemini.config.json       ← 主配置（含当前活跃槽位标识）
```

---

## 三、Twin-System 生命周期

```
┌─────────────────────────────────────────────────────────┐
│                    正常运行阶段                            │
│                                                          │
│   用户对话 → slot-A 处理 → 积累 trace/feedback           │
│                                                          │
└──────────────────────┬──────────────────────────────────┘
                       │ 触发条件满足
                       ▼
┌─────────────────────────────────────────────────────────┐
│                    意图生成阶段                            │
│                                                          │
│   skill-self-optimizer 分析 trace                        │
│   → 发现可优化点（行为模式、bug、新能力需求）              │
│   → 生成"进化意图"（结构化的改动描述）                    │
│                                                          │
└──────────────────────┬──────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────┐
│                    代码变异阶段                            │
│                                                          │
│   AI Coding Agent（mc --code）在 slot-B 目录工作         │
│   → 基于意图生成代码变更                                  │
│   → slot-A 继续正常服务，互不干扰                         │
│                                                          │
└──────────────────────┬──────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────┐
│                    验证阶段                               │
│                                                          │
│   在隔离端口启动 slot-B 进程                              │
│   → 运行自动化测试套件                                    │
│   → 运行行为一致性检查（对比 A/B 输出）                   │
│   → 人工审核摘要（可选，早期必须）                        │
│                                                          │
└──────────────────────┬──────────────────────────────────┘
                       │ 验证通过
                       ▼
┌─────────────────────────────────────────────────────────┐
│                    切换阶段                               │
│                                                          │
│   1. 迁移共享状态（sessions/memory/traces）               │
│   2. 更新软链接：active → slot-b，standby → slot-a       │
│   3. 重启 gateway 进程（指向新 active）                   │
│   4. 原 slot-A 进入待机态，成为下一次进化的起点           │
│                                                          │
└─────────────────────────────────────────────────────────┘
```

---

## 四、进化引擎详解

### 4.1 意图层（Intent）

意图的来源有三类：

| 来源 | 描述 | 优先级 |
|------|------|--------|
| **skill-self-optimizer** | 从对话 trace 自动提炼改进点 | 自动 |
| **用户显式指令** | "把这个功能加进去" | 最高 |
| **上游 OpenClaw 新版本** | AI 分析 diff，筛选值得吸收的功能 | 定期 |

意图格式（结构化）：
```json
{
  "id": "intent-20260503-001",
  "type": "behavior_fix | new_feature | upstream_sync",
  "description": "typed hook 注册缺少重复检查，导致 hot-reload 后累积",
  "target_files": ["src/plugins/loader.ts"],
  "evidence": ["trace-session-xxx", "upstream-diff-v2026.4.22"],
  "risk_level": "low | medium | high",
  "requires_human_approval": false
}
```

### 4.2 变异层（Mutator）

- 调用 `mc --code` 在 `standby/` 目录执行变更
- 每次变更对应一个 git commit，保留完整历史
- 变更范围受 `risk_level` 约束：high 风险变更必须人工审核

### 4.3 验证层（Validator）

验证分三个层次：

```
Level 1 — 静态检查（快，秒级）
  TypeScript 编译通过
  单元测试通过
  lint 无错误

Level 2 — 行为一致性（慢，分钟级）
  启动 slot-B 在隔离端口
  重放历史 trace，对比 A/B 输出差异
  差异超过阈值则拒绝

Level 3 — 人工审核（按需）
  risk_level=high 或 requires_human_approval=true 时触发
  生成变更摘要推送给用户确认
```

### 4.4 熔断层（Circuit Breaker）

防止进化跑偏的护栏：

- **回滚触发条件**：切换后错误率上升 > 10%，自动回滚到 standby
- **进化频率限制**：同一文件 24 小时内最多变更 3 次
- **人工介入点**：连续 2 次验证失败，暂停自动进化，通知用户
- **核心文件保护**：`evolution/` 目录下的文件变更必须人工审核（防止进化引擎自我破坏）

---

## 五、与 OpenClaw 上游的关系

GeminiClaw 不做传统 merge，而是**主动筛选**：

```
定期任务（每周）：
1. AI 获取上游最新版本的 changelog/diff
2. 分析哪些变更与 GeminiClaw 的方向相关
3. 生成"上游同步意图"，走正常进化流程
4. 人工决策：要 / 不要 / 改了再要
```

这样既保持对上游的感知，又不被上游的节奏绑架。

---

## 六、skill-self-optimizer 的新定位

在 GeminiClaw 架构下，skill-self-optimizer 不再是一个受限的"Skill 优化器"，而是**进化引擎的意图层核心**：

- 原来：分析 trace → 优化 Skill 文件
- 现在：分析 trace → 生成进化意图 → 驱动整个 Twin-System 进化

它的能力边界从"改 Skill"扩展到"改运行时本身"。

---

## 七、当前实现：Twin-System + Factory DI

> 2026-05 已实现，以 git 分支（而非物理目录）实现双槽位。

### 7.1 目录结构

```
src/twin-system/              ← 新的类型安全进化引擎
├── types.ts                  ← 核心类型定义 (SlotId, EvolutionIntent, PipelineConfig...)
├── slot-manager.ts           ← 双槽位生命周期管理（git-branch based）
├── safety-guard.ts           ← 安全护栏（保护路径、频率限制、熔断器）
├── evolution-pipeline.ts     ← 流水线编排（intent → mutate → validate → switch）
├── mutator-impl.ts           ← LLM 驱动代码变异（unified diff + fuzzy apply + tsc check）
├── validator-impl.ts         ← 二级验证（L1: build+test, L2: 临时进程+行为回放）
├── persistence.ts            ← SQLite 持久化（slots、records、circuit breaker、频率）
├── intent-aggregator.ts      ← 多源意图收集 + 去重 + 优先级排序
├── post-switch-monitor.ts    ← 切换后监控 + 自动回滚
├── scheduler.ts              ← 调度器（idle 检测 + cron + 手动触发 + cooldown）
├── factory.ts                ← DI 容器：配置 → 实例化所有组件 → 真实适配器
└── e2e-smoke.test.ts         ← 端到端集成测试
```

### 7.2 Factory 层

`factory.ts` 是整个 twin-system 的组装入口，负责：

1. **读取 `config.evolution`** — Zod schema 校验后的配置对象
2. **实例化真实适配器** — 将接口绑定到 Node.js 运行时：
   - `NodeFileSystem` → `fs` 模块
   - `TscTypeChecker` → `npx tsc --noEmit`
   - `SlotGitOpsAdapter` / `MutatorGitOpsAdapter` → `git` CLI
   - `ProviderRouterLlmClient` → 复用主 ProviderRouter（同配置、同 fallback）
   - `ExecCommandRunner` / `ExecProcessSpawner` → `child_process`
   - `HttpHealthChecker` / `HttpBehaviorTester` / `HttpHealthProbe` → HTTP 探针
   - `ServerErrorCounter` → 内存请求计数器
   - `SimpleFuzzyMatcher` → trim 比对 fallback
   - `RequestActivityTracker` → idle 检测数据源
3. **组装组件依赖图**：

```
Config
  → PersistenceAdapter(db)
  → SafetyGuard(config, persistence)
  → SlotManager(gitOps, config)
  → MutatorImpl(fs, typeChecker, git, llm, config)
  → ValidatorImpl(runner, spawner, health, behavior, config)
  → EvolutionPipeline(slotManager, safetyGuard, mutator, validator, config)
  → PostSwitchMonitor(probe, counter, slotManager, config)
  → IntentAggregator()
  → SchedulerRunner(tracker, onTrigger: pipeline.run, config)
```

4. **返回 `TwinSystemInstance`** — 暴露 `start()` / `stop()` + 各组件引用

### 7.3 接入点

`src/index.ts` 中的启动流程：

```typescript
const twinSystem = createTwinSystem(config.evolution, router, db, config.server.port)
await server.listen(...)
twinSystem.start()   // enabled=false 时打印 log 但不启动调度器
process.on("SIGTERM", () => { twinSystem.stop(); server.close() })
```

### 7.4 配置

所有进化参数均在 `config.yaml` 的 `evolution:` 段配置，有完整默认值：

```yaml
evolution:
  enabled: false           # 总开关
  dataDir: ".gemini-data"
  idleThresholdMs: 300000
  cronIntervalMs: 1800000
  cooldownMs: 600000
  maxMutationRounds: 3
  confidenceThreshold: 0.7
  testPort: 19889
  postSwitchMonitorMs: 300000
  failureRateThreshold: 0.1
  protectedPaths: [...]
  maxEvolutionsPerFile24h: 3
  autoSwitch: false
  mainBranch: "main"
```

---

## 八、非阻塞子任务委派（OpenClaw-style Async Delegation）

### 8.1 问题背景

旧的 `delegate_tasks` 工具采用同步阻塞模式：父 Agent 调用后 `await orchestrator.execute()` 直到所有子任务完成才返回。这导致：

- 主 Agent 被阻塞数分钟，无法响应用户新消息
- QQ Bot 的"打断任务"按钮无法中止已启动的子任务
- 打断后 `processWithAgent` 返回空字符串，ws-client 不判空直接发送 → 空回复

### 8.2 新架构（v2）

采用 OpenClaw 的 fire-and-forget + 事件总线 + 结果注入模式：

```
用户消息 → AgentLoop → 模型调 delegate_tasks
                              │
                              ▼
                    asyncExecute() ← 立即返回 "accepted"（≤10ms）
                              │
                              ├─→ 注册到 SubagentRegistry
                              ├─→ 发布 lifecycle:start 事件
                              └─→ void executeInBackground()  ← fire-and-forget
                                        │
                                        ▼
                              Orchestrator.execute()（后台异步）
                                        │
                                        ▼ 完成
                              completeRun() → emitLifecycle(phase: "end")
                                        │
                                        ▼
                              ResultInjector 监听到事件
                                        │
                                        ▼
                              pushFn(userId, result) → QQ Bot 主动推送
```

### 8.3 核心组件

| 组件 | 文件 | 职责 |
|------|------|------|
| LifecycleBus | `src/multi-agent/lifecycle-bus.ts` | 进程内事件总线，发布/订阅子任务生命周期事件 |
| SubagentRegistry | `src/multi-agent/subagent-registry.ts` | 子任务注册表，跟踪状态，内置超时 sweeper |
| AsyncExecutor | `src/multi-agent/async-executor.ts` | fire-and-forget 执行器，后台运行 Orchestrator |
| ResultInjector | `src/multi-agent/result-injector.ts` | 监听完成事件，通过渠道推送结果给用户 |
| delegate_tasks (v2) | `src/tools/delegate_tasks.ts` | 非阻塞工具，调用 asyncExecute 后立即返回 |

### 8.4 用户体验

```
用户: "帮我爬取板块数据"
Bot:  "好的，我来启动浏览器爬取任务。"
Bot:  [delegate_tasks 返回] "✅ 已接受 1 个子任务，后台执行中。"
Bot:  "你可以继续问我其他问题。"

用户: "今天天气怎么样？"        ← 不被阻塞！
Bot:  "今天北京晴，25°C..."

[30s 后，子任务完成]
Bot:  "📋 后台任务完成（耗时 32s）     ← 主动推送
       任务：爬取板块数据
       ✅ 获取到 28 个板块..."
```

### 8.5 止血修复（同步完成）

- `ws-client.ts`：空回复判空，不发送空消息
- `index.ts`：signal 透传给 toolContextExtra，打断可传递到子任务
- abort 后返回空字符串由 ws-client 判空拦截，不再发送

---

## 九、实施路线

- [x] **Step 1**：基础运行时（2026-05-05）
  - TypeScript + Fastify 5 + Vitest
  - providers: Anthropic、mcli、llm-gw、Friday
  - memory: buffer + layered 策略
- [x] **Step 2**：Twin-System 核心类型 + SlotManager + SafetyGuard + Pipeline
- [x] **Step 3**：进化引擎组件 — MutatorImpl、ValidatorImpl、PersistenceAdapter、IntentAggregator、PostSwitchMonitor、SchedulerRunner
- [x] **Step 4**：Integration Wiring — factory.ts DI + config schema + index.ts 接入
- [x] **Step 5**：E2E smoke test（13 个端到端集成测试）
- [x] **Step 6**：Dead code cleanup（删除未引用的旧文件）
- [ ] **Step 7**：迁移 server/index.ts 中的旧 EvolutionEngine → 新 twin-system
- [ ] **Step 8**：删除完整 src/evolution/ 目录
- [ ] **Step 9**：启用进化循环实际运行（`evolution.enabled: true`）

---

## 九、核心设计原则

1. **始终有退路**：任何时候都能一键回滚到上一个稳定态
2. **人在回路**：早期所有 high-risk 变更必须人工确认（`autoSwitch: false`）
3. **渐进自动化**：先手动跑通，再逐步自动化，不跳步
4. **进化引擎受保护**：`src/twin-system/` 和 `src/config/` 在 protectedPaths 中，不参与自动进化
5. **依赖注入**：所有外部 IO 通过接口注入，组件可独立测试
6. **状态与代码分离**：SQLite DB 独立于槽位，切换时不丢数据
