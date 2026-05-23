# GeminiClaw Task-Aware Memory System 设计文档

> 状态：设计完成，待实现  
> 作者：观澜  
> 日期：2026-05-23  
> 依赖：`docs/COMPACTION-DESIGN.md`

---

## 一、总体架构

```
┌─────────────────────────────────────────────────────────────┐
│                    Layer 3: Task Manager                     │
│  任务识别(haiku) │ L1/L2/L3 摘要 │ 关系图 │ 搜索 │ 命令系统 │
├─────────────────────────────────────────────────────────────┤
│                    Layer 2: Compaction                       │
│    Preflight 估算 │ 三段式压缩 │ Tool pair 保护 │ 摘要叠加   │
├─────────────────────────────────────────────────────────────┤
│                    Layer 1: Persistent Storage               │
│              SQLite（per GeminiClaw host）                   │
└─────────────────────────────────────────────────────────────┘
```

三层依赖关系：持久化是地基，Compaction 建在上面，Task Manager 建在最上层。

---

## 二、SQLite 存储层

### 数据库位置
```
{dataDir}/memory.db
# 初代2015: /Users/pingjiangli/Code/GeminiClaw/.gemini-data/memory.db
# 每个 GeminiClaw 主机独立一份
```

### Schema

```sql
-- 任务表
CREATE TABLE tasks (
  id          TEXT PRIMARY KEY,          -- 可读 slug，如 dragon-stock-api
  title       TEXT NOT NULL,             -- 模型生成的标题
  status      TEXT NOT NULL DEFAULT 'active',
              -- active | paused | completed | abandoned
  is_temp     INTEGER NOT NULL DEFAULT 0, -- 1 = 临时任务
  parent_id   TEXT REFERENCES tasks(id), -- 父任务
  user_id     TEXT NOT NULL,             -- QQ openid
  l1_summary  TEXT,                      -- 1-2句话摘要
  l2_summary  TEXT,                      -- ~40-50句话摘要
  created_at  INTEGER NOT NULL,          -- unix timestamp
  updated_at  INTEGER NOT NULL
);

-- 消息表（全量存储，永不删除）
CREATE TABLE messages (
  id          TEXT PRIMARY KEY,          -- UUID
  task_ids    TEXT NOT NULL,             -- JSON 数组，["task-a", "task-b"]
  user_id     TEXT NOT NULL,
  role        TEXT NOT NULL,             -- user | assistant | tool
  content     TEXT NOT NULL,
  tool_name   TEXT,                      -- tool call 时的工具名
  tool_call_id TEXT,                     -- tool call id（配对用）
  session_id  TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);

-- 任务关系表
CREATE TABLE task_relations (
  from_task   TEXT NOT NULL REFERENCES tasks(id),
  to_task     TEXT NOT NULL REFERENCES tasks(id),
  relation    TEXT NOT NULL,
              -- parent | reference | dependency | related
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (from_task, to_task, relation)
);

-- 跨任务引用表（消息内的精确引用）
CREATE TABLE task_refs (
  id          TEXT PRIMARY KEY,
  from_task   TEXT NOT NULL,
  from_msg_id TEXT NOT NULL,
  to_task     TEXT NOT NULL,
  to_level    INTEGER NOT NULL,          -- 1 | 2 | 3
  ref_lines   TEXT,                      -- "1-5" 或 null（整层）
  created_at  INTEGER NOT NULL
);

-- 全文搜索虚表
CREATE VIRTUAL TABLE tasks_fts USING fts5(
  id UNINDEXED,
  title,
  l1_summary,
  l2_summary,
  content='tasks',
  content_rowid='rowid'
);

CREATE VIRTUAL TABLE messages_fts USING fts5(
  id UNINDEXED,
  content,
  content='messages',
  content_rowid='rowid'
);
```

---

## 三、任务管理系统

### 3.1 任务层级（L1/L2/L3）

层级是**摘要粒度**，与压缩触发解耦——数据库永远存全量，层级只影响 context 加载粒度。

| 层级 | 内容 | 用途 |
|------|------|------|
| L1 | 1-2句话，任务标题+核心状态 | 默认加载，让 AI 知道有这个任务 |
| L2 | ~40-50句话，关键决策+进展细节 | 需要了解任务时加载 |
| L3 | 完整对话消息流 | 深度工作时加载，可在 context 内压缩 |

**生成时机**：模型驱动，不自动触发。AI 在合适时机通过工具调用更新摘要。
- L1：任务创建后第一次有实质内容时生成
- L2：L1 超出 1-2 句话的信息量时生成
- L3：即原始消息，随时可查

**L3 在 context 中的压缩**：L3 原始数据永远在 DB 里完整保留。加载到 context 时若太长，在 context 中压缩（走 Compaction 机制），不影响 DB 存储。

### 3.2 任务识别流程

```
消息入站
  │
  ▼
[快模型 haiku] 分类
  │  输入：{message, active_task_list: [{id, title, l1}]}
  │  输出：{task_ids: ["a","b"], is_new: bool, new_title?: str, is_temp: bool}
  │
  ├─→ 归属已有任务（可多个）
  ├─→ 创建新任务（haiku 同时生成 slug + title）
  └─→ 归入临时任务（is_temp=true）
```

**Task ID 生成规则**：
- 模型生成英文 slug，最长 32 字符，如 `dragon-stock-api`
- 冲突时加 `-2`、`-3` 后缀

**临时任务定义**（prompt 中的判断标准）：
- 与任何现有任务无关联
- 自身没有持续性或深度（单次问答、小事项）
- 临时任务默认不加载到 context，搜索时最低优先级
- 可由模型判断升级到正式任务或挂到父任务下

### 3.3 上下文组装

每条消息处理前，系统 prompt 中注入任务感知 hint：

```
You have a task management system. Active tasks: {count} tasks.
Use task tools (task_search, task_load, task_update) to:
- Load relevant task context before responding
- Update task summaries when significant progress is made
- Create/link tasks when new work emerges
```

AI 通过工具调用主动加载上下文，**迭代检索**：
1. 调 `task_search` 找相关任务
2. 默认加载 L1
3. 需要更多细节 → 调 `task_load(id, level=2)` 加载 L2
4. 深度工作 → 调 `task_load(id, level=3)` 加载 L3
5. 模型认为信息足够即停

**活跃任务数量无上限**，多了走 Compaction 压缩 L1 列表。

### 3.4 任务关系与跨任务引用

**关系类型**：
- `parent`：父子层级
- `reference`：内容引用（精确到层级+行）
- `dependency`：语义依赖（纯信息性，B 依赖 A 完成）
- `related`：主题相关

**引用格式**（由 AI 在内容中生成）：
```
[[ref:dragon-stock-api:L2:1-5]]
[[ref:geminiclaw-qqbot:L1]]
```
含义：引用 `dragon-stock-api` 任务 L2 摘要第 1-5 行。引用记录在 `task_refs` 表，支持双向索引。

---

## 四、Compaction 系统（更新版）

### 4.1 架构：Decorator Pattern

```typescript
class CompactionStrategy implements MemoryStrategy {
  constructor(
    private inner: MemoryStrategy,   // BufferStrategy
    private router: ProviderRouter,  // 用于摘要调用
    private config: CompactionConfig
  )
}
```

### 4.2 Token 估算

```typescript
function estimateTokens(messages: Message[], tools: ToolSchema[]): number {
  const msgTokens = messages.reduce((sum, m) =>
    sum + Math.ceil(m.content.length / 4), 0)
  const toolTokens = Math.ceil(JSON.stringify(tools).length / 4)
  return (msgTokens + toolTokens) * SAFETY_MARGIN  // 1.2x
}
```

**关键**：工具 schema 也要计入（Hermes 经验：50 个工具可达 20-30K token）。
当前 GeminiClaw 只有 7 个工具，影响小，但随工具增加会显著。

**待验证**：`chars/4` 与实际 token 数的误差测算。采样 10~20 轮真实对话，对比估算值与 API 返回的 `usage.input_tokens`，误差 >20% 则引入 `tiktoken`。

### 4.3 触发条件

```typescript
if (estimateTokens(messages, tools) > contextWindow * config.threshold) {
  await compact()
}
// 默认 threshold = 0.75，contextWindow 按模型动态查表
```

### 4.4 压缩结构：三段式 + Tool Pair 保护 + 摘要叠加

```
[消息 0: 系统人格]          ← 永不压缩
[SUMMARY 摘要消息]          ← 上次叠加产物
[最近 keepLast 条消息]      ← 永不压缩
```

**Tool Pair 保护**（新增）：
```typescript
// 压缩边界必须落在 tool call/result 配对之外
// 扫描待压缩消息，遇到未配对的 tool call 把边界往前退
function findSafeCutPoint(messages: InternalMessage[], cutIdx: number): number {
  const pendingCalls = new Set<string>()
  for (let i = cutIdx; i >= 0; i--) {
    const m = messages[i]
    if (m.role === 'tool') pendingCalls.add(m.tool_call_id)
    if (m.role === 'assistant' && m.tool_calls) {
      for (const tc of m.tool_calls) {
        if (!pendingCalls.has(tc.id)) return i - 1  // 退到 pair 之前
        pendingCalls.delete(tc.id)
      }
    }
  }
  return cutIdx
}
```

**摘要叠加**：
```
新摘要 = summarize(旧摘要内容 + 新增待压缩消息)
```
新摘要包裹在 `[CONVERSATION_SUMMARY]...[/CONVERSATION_SUMMARY]` 标记中，下次压缩可识别并合并。

---

## 五、AI 工具集（Task 相关）

AI **不直接操作 SQL**，所有任务操作通过封装好的工具调用完成。
工具是 GeminiClaw 的内置 Skill，隐藏所有 DB 细节，AI 只接触干净的接口。

```typescript
// 搜索任务
task_search(query: string, level?: 1|2|3, status?: string): Task[]

// 加载任务上下文
task_load(taskId: string, level: 1|2|3): TaskContext

// 创建任务
task_create(title: string, description: string, parentId?: string): Task

// 更新任务摘要
task_update_summary(taskId: string, level: 1|2|3, content: string): void

// 更新任务状态
task_update_status(taskId: string, status: 'active'|'paused'|'completed'|'abandoned'): void

// 建立任务关系
task_link(fromId: string, toId: string, relation: 'reference'|'dependency'|'related'): void

// 列出活跃任务
task_list(status?: string, limit?: number): Task[]

// 升级临时任务
task_promote(tempTaskId: string, parentId?: string): Task
```

---

## 六、命令系统

所有命令统一处理，AI 是主要使用者，用户也可通过 QQBot 输入。

**识别规则**：消息以 `/` 开头即为命令，后端统一解析后交给 AI 处理。

**Task 系统命令**（AI 和用户均可用）：

```
/tasks                         列出活跃任务
/tasks all                     列出全部任务
/tasks search <关键词>          搜索任务（模型决定搜哪层）
/task <id>                     查看任务详情
/task done <id>                标记完成
/task pause <id>               暂停任务
/task link <id1> <id2> <关系>  建立关系
```

命令与其他工具（exec shell、换模型等）统一注册在命令系统中，不特殊处理。

---

## 七、实现阶段规划

```
Phase 1：持久化地基
  - SQLite schema 建表（memory.db）
  - BufferStrategy → SqliteStrategy（消息持久化）
  - 进程重启后历史恢复

Phase 2：Compaction
  - CompactionStrategy Decorator
  - Token 估算（含 tool schema）
  - Tool pair 保护
  - 三段式摘要叠加

Phase 3：Task Manager
  - 任务识别（haiku 分类）
  - L1/L2/L3 摘要工具
  - 任务 CRUD 工具
  - 系统 prompt 任务感知注入
  - 迭代检索流程

Phase 4：关系与引用
  - 任务关系图（dependency/related/reference）
  - 跨任务引用格式解析
  - 临时任务升级逻辑

Phase 5：命令系统
  - / 前缀命令解析器
  - Task 命令集注册
  - QQBot 命令交互
```

---

## 八、知识图谱（规划，暂不实现）

**思路**：作为 side task 后台静默运行，从所有对话中抽取实体与关系，构建用户画像。

**目标**：理解用户（李平江）的：
- 知识体系与技术栈（Java/Spark/大数据/AI Agent）
- 工作方向与项目
- 个人能力层次
- 性格与偏好

**技术方向**：
- 轻量级图存储（SQLite nodes + edges 表，或 `better-sqlite3` + adjacency list）
- 实体类型：人、项目、技术、概念、事件
- 关系类型：works_on、knows、uses、related_to、inferred_from
- 难点：实体去重（同一事物不同叫法的合并）

**前提**：全量对话历史已持久化（Phase 1 完成后随时可启动）。

**等待条件**：待 Phase 1-3 稳定后作为独立探索项启动。

---

## 九、Token 估算误差测算计划

**方法**：
1. 采样 20 轮真实对话（含工具调用）
2. 用 `chars/4 × 1.2` 公式计算估算值
3. 对比 Anthropic API 返回的 `usage.input_tokens` 实际值
4. 计算平均误差和最大误差

**判断标准**：
- 平均误差 <20%：保持现有方案
- 平均误差 20~40%：调整系数（如改为 `chars/3.2`）
- 平均误差 >40%：引入 `tiktoken`（npm: `js-tiktoken`）

**测算时机**：Phase 2 Compaction 上线后自然收集数据。
