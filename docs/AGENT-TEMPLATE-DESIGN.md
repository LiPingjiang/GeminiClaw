# Agent Template System Design

## 核心概念

- **模板（Template）**：持久的、会进化的。包含 AGENT.md（人格）、skills/（技能）、memory DB（记忆）
- **实例（Instance）**：短暂的、按需的。Session 粒度，用完即释放
- **用户视角**：模板 = Agent，不感知底层实现（"股票助手"、"代码助手"）

---

## 架构流程

```
用户消息
  → 引导层（每条消息都过，轻量关键词匹配 + LLM 语义兜底）
  → Agent Pool（根据模板名返回/创建实例）
  → 实例处理
      ├── AGENT.md：读模板原件（只读）
      ├── skills/：读模板原件（只读）
      └── memory DB：按 session_id 隔离查询（共享同一 DB，天然隔离）
  → 回复用户
  → /new 命令 → closeSession() → 后台异步 append memory 到模板 DB
```

---

## 目录结构

```
~/.gemeniclaw/templates/
├── base/                    ← 默认通用模板（系统首次启动时自动创建）
│   ├── template.yaml        ← 模板元信息（name/description/keywords）
│   ├── AGENT.md             ← 从 AGENT.md.template 渲染生成
│   └── skills/              ← 技能目录
└── stock-agent/             ← 复制自 base 的专精模板
    ├── template.yaml
    ├── AGENT.md
    └── skills/
```

**Memory DB 位置：** `~/.gemeniclaw/memory/geminiclaw.db`（所有模板实例共享，按 session_id 隔离）

---

## template.yaml 格式

```yaml
name: stock-agent
display_name: 股票助手
description: 专精股票分析、行情解读、量化策略的 Agent
keywords:
  - 股票
  - 行情
  - K线
  - 量化
  - 基金
created_at: 2026-05-24T12:00:00Z
copied_from: base         # 可选，复制自哪个模板
```

---

## 引导层（Guidance Layer）

- **插入位置：** QQ Bot 收到消息后，AgentLoop 之前
- **路由分级：**
  1. 关键词匹配（零成本，扫描 `template.yaml` 的 keywords）
  2. LLM 语义判断（第一层不确定时兜底）
  3. 匹配失败 → 默认 base 模板
- **Session 内切换：** 每条消息都过路由，话题偏移时自动切换（股票相关代码继续用股票 Agent，跨项目切换到对应 Agent）
- **路由纠错：** 用户纠正时，LLM 动态增加 keywords 到 template.yaml，逐步优化

---

## Agent Pool

- **单进程 async 并发**（Node.js I/O 密集场景足够）
- **职责：** 资源管理器，按模板名返回/创建实例
- **实例生命周期：** Session 开始创建，`/new` 命令时销毁
- **并发实例：** 同一模板可有多个实例（不同 session），共享只读的 AGENT.md/skills，memory 按 session_id 隔离

---

## Session 结束 & 记忆回写

**触发时机：** 用户发 `/new` 命令（参考 Claw 的 session-memory hook + Hermes 的 closeSession()）

**实现方式：**
1. `/new` handler 调用 `closeSession(currentSessionId)`
2. 后台异步执行，不阻塞 `/new` 的即时响应
3. 读取本次 session 的对话历史（最近 N 条）
4. 直接 append 到模板的 memory_topics 表（简单累加，不做 LLM 筛选）
5. 记录格式：`{title: 'Session YYYY-MM-DD HH:mm', summary: '对话摘要文本', ...}`

---

## 模板操作（gc 命令）

```bash
gc template list                    # 列出所有模板
gc template show <name>             # 查看模板详情
gc template create <name>           # 从 base 复制创建新模板
gc template copy <src> <dst>        # 复制模板
gc template edit <name>             # 编辑 template.yaml
```

---

## 模板的创建与进化

- **第一个模板：** base，系统首次启动时自动创建，包含机器路径、配置位置等基础信息
- **新模板：** 复制（不是 fork），完全独立，不维护父子关系
- **进化：** 通过 Session 结束时的 memory append 逐渐积累经验
- **文件修改保护：** 修改模板文件前先备份（`template.yaml.bak.timestamp`），定期清理老备份

---

## 关键设计决策

| 决策点 | 方案 | 理由 |
|--------|------|------|
| Memory 隔离 | 共享 DB + session_id 隔离 | DB 已有 session_id 字段，天然隔离，无需复制 |
| AGENT.md/skills | 只读共享模板原件 | 实例运行时不修改，无需副本 |
| 并发模型 | 单进程 async | LLM API 是 I/O 密集，Node.js async 足够 |
| 回写触发 | /new 命令 | 参考 Claw + Hermes，语义明确 |
| 回写内容 | 直接 append memory | 简单可靠，避免 LLM 筛选引入的不确定性 |
| 模板关系 | 复制（无父子关系）| 避免父子语义漂移，简单清晰 |
| 锁机制 | 写入时加锁 + 超时释放 | 防止并发回写冲突 |

---

## 实现阶段

### Phase 1：模板基础设施
- 模板目录结构 + base 模板自动初始化
- `template.yaml` Zod schema
- `gc template` 命令集（list/show/create/copy）
- 模板加载到 `loadSystemPrompt()`

### Phase 2：引导层 + 路由
- GuidanceLayer 类，插入 AgentLoop 之前
- 关键词匹配 + LLM 语义兜底
- Session → 模板绑定（内存中）

### Phase 3：Agent Pool 接入模板
- Pool 按模板名管理实例
- 实例持有 templateName，读 AGENT.md/skills 时走模板路径

### Phase 4：Session 结束回写
- `/new` handler 调用 `closeSession()`
- 后台 append memory_topics 记录到 DB
- 写入锁 + 超时机制
