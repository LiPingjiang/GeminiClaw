# Skill Evolution — 改进路线图（vs Hermes 对照）

> 本文档记录技能级自进化引擎（Hermes-style）当前实现与 Hermes Agent 内置
> Skill 闭环的差距，以及后续分步骤改进计划。
>
> 背景：我们对标的是 **Hermes Agent 内置的 Skill 闭环**（Periodic Nudge +
> `skill_manage` + 三层记忆 + Progressive Disclosure），不是独立的
> `hermes-agent-self-evolution`（DSPy + GEPA 离线进化）。

## 闭环四步：OBSERVE → REFLECT → CRYSTALLISE → REUSE

| 步骤        | 含义                       | 我们的实现                              | 状态 |
| ----------- | -------------------------- | -------------------------------------- | ---- |
| OBSERVE     | 观察对话历史，发现候选     | `ConversationCandidateSource`（SQL+打分） | ✅ 比 Hermes 更强 |
| REFLECT     | 反思决定 create/refine/skip | `SkillReflector`（LLM + JSON 硬化）     | ✅ 同源 |
| CRYSTALLISE | 结晶成 SKILL.md            | `SkillStore`（frontmatter + Markdown）  | ⚠️ 缺模板 |
| REUSE       | 复用技能、回写反馈         | **无**（chat.ts 未引用技能）           | ❌ 断环 |

前三步是「生产技能」，REUSE 是「消费技能」。**当前 REUSE 断裂 = 引擎只进不出，
结晶出的技能躺在磁盘上无人加载，等于「会记笔记但从不翻看」。**

---

## 我们已有的优势（保持）

1. **离线候选发现**：基于真实 DB 的多信号打分选材（短回复 / 错误标记含中文 /
   用户重复请求 / 富多轮任务），Hermes 没有这套离线信号提取。
2. **双引擎独立可控**：skill 引擎 + code 引擎独立开关，后台调度可控，不依赖
   LLM 自觉。
3. **手动扫描 API**：可指定时间窗 / 会话批量复盘。

---

## 调度节流策略（已落地 / 进行中）

**问题**：早期配置过激（idle 1min + cron 30min + cooldown 30s），引擎几乎「天天在
create/refine」，技能库不断翻搅，既费 token 又把内容磨花。

**决策（用户确认）**：从「激进自动」改为「克制自动 + 用户主动」。

1. **一天一反思**：每日凌晨 **3:00（北京时间 = 服务器本地 CST/UTC+8）** 触发一次
   反思进化，不再 idle 触发、不再 30min 轮转。
   - 实现：`SchedulerRunner` 新增 `dailyAtHour`（0-23）一次性 `setTimeout`，
     按服务器本地 `getHours()` 计算到下一个 3:00 的毫秒数，触发后自动续约到次日。
   - `dailyAtHour` 优先级高于 `cronIntervalMs`；设置后两者互斥。
   - `SkillEvolutionEngine` 同步把 `idleEnabled` 置 false（空闲不再触发）。
   - 链路：`config/schema.ts` → `orchestrator.ts` → `SkillEvolutionEngine`
     → `SchedulerRunner`。
   - 运行时配置：`evolution.skill.dailyAtHour: 3`、关闭 idle、
     `maxActionsPerCycle: 1`、提高 `minScore`。
2. **每轮动作收敛**：`maxActionsPerCycle` 降到 1，每次最多动一项，避免一夜翻搅。
3. **用户主动进化（待做）**：底层已有 `POST /v1/skill-evolution/scan` +
   `runWithSource()`。计划补一个用户可触发的 `/evolve` 命令，当用户觉得执行路径有
   问题时，主动发起一次复盘进化（而非等到凌晨）。

> 备注：「空闲触发」的空闲判定 = 距上次 HTTP 请求的时长（`RequestActivityTracker`
> 在 `chat.ts` 里 `recordActivity()`，`getIdleMs() = now − lastActivity`）。本次
> 改造已禁用该触发，仅保留每日定点 + 手动。

---

## 改进项（按优先级与依赖关系排序）

### P0-A. SKILL.md 结构化模板 ✦ 低成本高收益，独立可做

**现状**：body 由 LLM 自由发挥，无固定骨架；frontmatter version 为整数、无 category。

**目标**：强制 body 含四段固定结构（对齐 Hermes）：
- `## When to Use` — 触发条件（**复用回路的检索锚点**）
- `## Procedure` — 步骤
- `## Pitfalls` — 已知坑与修复
- `## Verification` — 如何确认成功

**做法**：在 `SkillReflector` 的 system prompt 中规定 body 必须含这四个 section；
解析时校验缺段则降级处理。

**难点**：几乎没有，纯 prompt + 校验。
**依赖**：无。**收益**：产出质量稳定、可检索性立刻提升。

> 注：**分类（category 目录分层）暂不做** —— 技能数为个位数，过早分类是过度工程，
> 待规模上百再加。

### P0-B. 原子写入 ✦ 低成本，独立可做，与复用无关

**现状**：`writeFileSync` 直接写，进程崩在写一半会损坏 SKILL.md。

**目标**：tempfile + `rename`（os.replace 语义）原子落盘。

**难点**：几行代码。**依赖**：无（数据完整性问题，非安全问题）。

### P1. patch 精细更新 ✦ 中等成本，优化项

**现状**：只有 `update()` = 整体重写 body，每次 refine 重写整篇，费 token 且
易把好内容覆盖坏。

**目标**：新增 patch（find-and-replace，只改变更部分）。

**难点**：fuzzy matching —— LLM 给的 `old_string` 常与文件内容有空白/缩进/标点
漂移。
**分步**：
1. 先做 **exact-match patch**（精确匹配才替换，失败 fallback 整体 rewrite）——
   ~30 行，覆盖约 70% 场景。
2. 再做 **fuzzy patch**（空白归一化 + 缩进容忍 + 最相似片段）。

**为什么没一开始做**：MVP 阶段优先验证闭环主干能从真实历史长出技能；0 技能时
refine 触发频率低，整体重写够用，patch 是优化非阻塞。

### P2. REUSE 复用回路 ✦✦✦ 架构级，最难，最关键，是其他一切的前提

**现状**：`chat.ts` 完全未引用技能；`recordUsage()` 已实现但**无人调用**。

**目标**：让对话主链路在每次请求时：
1. **加载** `~/.geminiclaw/skills/` 技能索引（Level 0：name + description）
2. **检索匹配**：依当前任务判断该加载哪个技能（靠 `When to Use`）
3. **注入** 命中技能全文（Level 1）进 system prompt
4. **回写** `recordUsage()`，记录采纳，驱动「越用越准」

**为什么必须做**：不复用，前三步白做。复用的三层价值——
(1) 让经验真正生效（同类任务不再从零摸索）；
(2) 闭合反馈、驱动 refine（只有被用过才知道哪不好用，recordUsage 才非 0）；
(3) 闭环才叫「自进化」，否则只是「自我总结」。

**关键困难（不在写代码，在架构耦合）**：
1. **检索/匹配**：怎么判断当前任务该加载哪个技能？关键词/embedding 匹配
   （建检索）vs Level 0 索引全注入让 LLM 自选（吃 token）。
2. **prompt 注入 + 缓存**：注入技能改 system prompt → 破坏 prompt cache → token
   成本飙升。Hermes 用 Frozen Snapshot + API-call-time ephemeral layer 解决。
   一旦接复用必须同时处理缓存策略。
3. **recordUsage 回写时机**：什么时候算「真的用了」一个技能？需在执行轨迹里识别
   技能确实被采纳。

**依赖**：无（但它是 P3 的前提）。

### P3. 安全门控（skills_guard）✦ 依赖 P2 才有意义

**现状**：仅 slugify + 重名转 refine；无安全扫描、无大小上限。

**目标**：对齐 Hermes `skills_guard`——写入后扫 prompt injection / 数据外泄 /
破坏性命令；大小上限（≤100K 字符）；扫描失败回滚（rmtree）。

**关键困难/为什么排后**：逻辑都是确定性的（无技术含量，纯工作量），但**威胁模型
只有在 REUSE 闭环后才成立**——技能不被加载执行时，磁盘上的 Markdown 无处发作
注入攻击。故优先级天然在 P2 之后。

**依赖**：P2（REUSE）。

### P4（可选）. Periodic Nudge — 在线即时结晶

**Hermes 是什么**：agent 对话循环里每 ~10 轮注入一段一次性提示，让 agent 趁热
（上下文最全）自省是否该存记忆/建技能/更新技能；ephemeral layer 不改 system
prompt（不破坏缓存）。

**我们有么**：无。我们用「后台定时扫历史库打分」替代了「对话内定时提醒」。

**是否要做**：可选。仅当我们想要「任务刚做完马上提炼」（趁热打铁、上下文最全、
质量高于离线扫库）时才需要这条线。

---

## 建议实施顺序

```
P0-A 模板  ┐
P0-B 原子写入 ┤ 独立、低成本、立刻可做、风险极低（不动主链路）
P1 patch    ┘ 独立、中等、优化项
                    ↓
P2 REUSE 复用回路 ← 架构级、最难、最关键（其他一切前提）
                    ↓
P3 安全门控 ← 依赖 P2
                    ↓
P4 Periodic Nudge ← 可选增强
```

**一句话依赖链**：模板/原子写入（随手做）→ patch（优化）→ **REUSE（核心欠债）**
→ 安全门控（REUSE 后必做）→ Periodic Nudge（可选）。
