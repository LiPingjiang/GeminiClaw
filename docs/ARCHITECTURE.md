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

## 七、第一阶段实施路线

> 目标：把基础建好，不急着接自动进化

- [x] **Step 1**：理清 GeminiClaw 仓库结构，跑通构建流程
  - 已完成（2026-05-05）：TypeScript + Fastify 5 + Vitest，78 测试全绿
  - providers: mcli（含 extraHeaders）、Friday（含 SSE stream）、Anthropic
  - memory: buffer 策略 + layered 策略（SQLite 分层 topics）
  - 认证、输入校验、SSE hijack 全部就位
- [x] **Step 2**：建立槽位机制（已用 git branch 方案替代物理 slot 目录，2026-05-06）
  - **决策记录**：ARCHITECTURE.md 原设计是 `slot-a/` + `slot-b/` 双目录 + 软链接。经评估，git branch 方案在当前阶段更优：
    - `main` = 运行态（slot-A），`evolution/<id>` branch = 待机态（slot-B）
    - 切换 = `git merge --squash` → main + SIGUSR1 重启；回滚 = `git revert HEAD`
    - **git branch 优势**：git log 天然就是进化历史，可审计；实现复杂度低 3 倍以上；`dist/` 已编译产物运行，src/ 改动无竞态
    - **物理 slot 目录的优势**（并发安全、依赖隔离）在当前阶段用不到：Mutator 只改 src/，主进程跑 dist/；Mutator 不动 package.json，依赖隔离暂无价值
    - **何时重新考虑物理 slot**：当进化引擎需要升级依赖、或需要真正零停机热切换时再做，现在做是过度设计
- [x] **Step 3（部分）**：Evolution Engine 核心模块全部实现（2026-05-06）
  - IntentEngine（TraceAnalyzer + MemoryTopicsAnalyzer + UpstreamSyncSource）
  - Mutator（LLM 生成 unified diff，置信度评分）
  - Validator Level 1（build + test）、Level 2（行为一致性）
  - Switcher（git branch 槽位切换 + SIGUSR1 重启）
  - CircuitBreaker（错误率监控 + 自动回滚）
  - 完整 auto-switch 路径验证通过（249 tests 全绿）
- [x] **Step 4**：上游跟踪（UpstreamSyncSource 已实现，通过 idle loop 自动触发，无需单独 cron）
- [ ] **Step 5**：Bootstrap intents（冷启动预置意图，避免新部署 trace 为空时无法进化）
- [ ] **Step 6**：时机隔离 + Evolution session 隔离（用户活跃时静默，进化确认不污染主对话）
- [ ] **Step 7**：部署替换生产 18888 端口

---

## 八、核心设计原则

1. **始终有退路**：任何时候都能一键回滚到上一个稳定态
2. **人在回路**：早期所有 high-risk 变更必须人工确认
3. **渐进自动化**：先手动跑通，再逐步自动化，不跳步
4. **进化引擎受保护**：evolution/ 目录的代码不参与自动进化，防止自我破坏
5. **状态与代码分离**：state/ 目录独立于槽位，切换时不丢数据
