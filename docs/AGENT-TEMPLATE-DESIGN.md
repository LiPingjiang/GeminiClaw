# Agent Template System — Complete Design

> 最后更新：2026-05-24

---

## 核心概念

| 概念 | 定义 |
|------|------|
| **模板** | 持久的、会进化的。包含 AGENT.md、skills、template.yaml。通用性资产。 |
| **Agent 实例** | 短暂的、按需的。绑定一个模板，有自己的名字、描述、任务列表。 |
| **Session** | 用户侧的会话容器。挂一个主 Agent，冗余存 main_agent_id。 |
| **Task** | Agent 管理的工作单元，树形结构，最深 4 层。 |
| **Sub-Agent** | 主 Agent spawn 的并行执行节点，共享父 Session，继承父模板。 |

用户只感知 Agent（有名字的机器人），不感知 Session / 模板等技术概念。

---

## 实体层级

```
Session
  └── Main Agent（主 Agent，parent_agent_id = NULL）
        ├── Sub-Agent 1（并行子任务，继承模板）
        │     └── Sub-Sub-Agent（depth=2，最深不限）
        └── Tasks（树形，最深 4 层）
              ├── Task（depth=0）
              │     ├── Subtask（depth=1）
              │     │     └── Subtask（depth=2）
              │     └── Subtask（depth=1）
              └── Task（depth=0）
```

**Sub-Agent vs Sub-Task 的选择依据：**
- 能并行 → spawn Sub-Agent
- 顺序/自己能处理 → Sub-Task
- 两者是独立概念，Task 的层级是 Task 自己的事

---

## 数据库 Schema

```sql
-- 已有，新增 main_agent_id 字段
ALTER TABLE chat_sessions ADD COLUMN main_agent_id TEXT;

-- 新增 agents 表
CREATE TABLE IF NOT EXISTS agents (
  id              TEXT PRIMARY KEY,
  session_id      TEXT NOT NULL REFERENCES chat_sessions(id),
  parent_agent_id TEXT REFERENCES agents(id),   -- NULL = 主 Agent
  template_name   TEXT NOT NULL,
  agent_name      TEXT NOT NULL,                -- 默认 agent-{id前8位}，LLM 异步更新
  description     TEXT,                         -- 主 Agent 与 Session 共用此描述
  depth           INTEGER NOT NULL DEFAULT 0,   -- 0 = 主 Agent
  status          TEXT NOT NULL DEFAULT 'active',  -- active/idle/completed/error
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 新增 tasks 表（邻接表，支持多级子任务）
CREATE TABLE IF NOT EXISTS tasks (
  id          TEXT PRIMARY KEY,
  agent_id    TEXT NOT NULL REFERENCES agents(id),
  session_id  TEXT NOT NULL REFERENCES chat_sessions(id),  -- 冗余，方便查询
  parent_id   TEXT REFERENCES tasks(id),  -- NULL = 根任务
  title       TEXT NOT NULL,
  description TEXT,
  status      TEXT NOT NULL DEFAULT 'pending',  -- pending/in_progress/done/cancelled
  depth       INTEGER NOT NULL DEFAULT 0,       -- 最大 4
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_agents_session ON agents(session_id);
CREATE INDEX IF NOT EXISTS idx_agents_parent  ON agents(parent_agent_id);
CREATE INDEX IF NOT EXISTS idx_tasks_agent    ON tasks(agent_id);
CREATE INDEX IF NOT EXISTS idx_tasks_parent   ON tasks(parent_id);
```

---

## 完整架构流程

```
用户消息
  │
  ▼
引导层（Guidance Layer）
  ├── 分词用户输入
  ├── 匹配活跃主 Agent 的 description + 当前 Task 摘要
  │     └── 多个匹配 → 选第一个（下层 Agent 可自我转移）
  ├── 未匹配 → misc Agent（base 模板，专处理临时任务）
  └── 新话题 → 创建新 Session + 新主 Agent
  │
  ▼
Agent Pool（资源管理器）
  ├── 按 agent_id 管理实例
  ├── 排队机制（参考 Claw Queue）
  └── 实例状态：active/idle/completed
  │
  ▼
Main Agent 处理
  ├── 读 AGENT.md（模板原件，只读）
  ├── 读 skills（模板原件，只读）
  ├── 读 memory（共享 DB，按 session_id 隔离）
  ├── [可能] spawn Sub-Agent（并行任务）
  └── [可能] 创建/更新 Task 树
  │
  ▼
回复用户
  └── QQ Bot 层加 [Agent名] 前缀
        例：[茅台分析] 今日茅台下跌 2.3%...
```

---

## 引导层（Guidance Layer）

**插入位置：** QQ Bot 收到消息后，AgentLoop 之前

**路由分级（每条消息都过）：**
1. 分词用户输入
2. 文字匹配：活跃主 Agent 的 `description` + 当前 `tasks.title`
3. 未匹配 → misc Agent
4. 路由纠错：Agent 自我转移（发给引导层，带目标 Agent 指定）
5. 成环检测：LLM 语义判断，成环 → 抛给用户决断

**Agent 自我转移：**
- Agent 发一条消息给引导层，格式和用户消息一样，但显式指定目标 Agent
- 引导层收到后知道来源是 Agent（非用户），转发给目标
- 目标 Agent 若也认为不适合自己 → 成环 → 返回用户

---

## Agent 命名规范

| 阶段 | 名字 |
|------|------|
| 创建时 | `agent-{id前8位}`（占位） |
| 第一条消息处理后 | LLM 生成有意义名字，异步更新 |
| 最终格式 | `{template}-{task-name}`，如 `stock-agent-茅台分析` |
| 回复前缀 | `[茅台分析] 正文...` |
| 用户视角 | 只看到名字，不感知模板/Session |

---

## Session 生命周期

| 事件 | 动作 |
|------|------|
| 用户无匹配 Session 时发消息 | 引导层创建新 Session + 主 Agent |
| `/new` 命令 | closeSession → 后台异步 append memory → 归档 |
| Idle 超时（1小时） | 同上，自动触发 |
| Agent 自我转移 | 消息重路由，Session 不关闭 |

**记忆回写（append）：**
- 读取本次 Session 最近 N 条消息
- 直接追加到模板 memory DB 的 `memory_topics` 表
- 不做 LLM 筛选，累加式增长
- 后台异步，不阻塞 `/new` 响应

---

## 模板目录结构

```
~/.gemeniclaw/templates/
├── base/                    ← 通用模板（首次启动自动创建）✓ Phase 1 已实现
│   ├── template.yaml
│   ├── AGENT.md
│   └── skills/
└── stock-agent/             ← 复制自 base 的专精模板
    ├── template.yaml
    ├── AGENT.md
    └── skills/
```

**template.yaml 格式：**
```yaml
name: stock-agent
display_name: 股票助手
description: 专精股票分析、行情解读、量化策略
keywords: [股票, 行情, K线, 量化, 基金]
created_at: 2026-05-24T12:00:00Z
copied_from: base
```

---

## 实现阶段

### ✅ Phase 1（已完成）
- 模板目录结构 + base 模板自动初始化
- `template.yaml` Zod schema + TemplateManager
- `gc template list/show/create/copy`
- `GET|POST /v1/templates`

### 🔲 Phase 2：DB 迁移 + Agent/Task 实体
- `agents` 表、`tasks` 表新增
- `chat_sessions` 加 `main_agent_id`
- Agent / Task CRUD API

### 🔲 Phase 3：引导层 + 多 Session 路由
- GuidanceLayer 类（分词匹配 + LLM 兜底）
- 新 Session 创建逻辑
- Agent 自我转移 + 成环检测
- `[Agent名]` 前缀注入（QQ Bot 层）

### 🔲 Phase 4：Agent Pool 接入模板
- Pool 按 template 初始化实例
- Sub-Agent spawn（并行，继承模板）
- 排队机制

### 🔲 Phase 5：Session 结束 + 记忆回写
- `/new` → closeSession → append memory
- Idle 1h 超时自动归档
- 写入锁 + 超时释放
