# 记忆检索与落盘修复 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use super-assistant:subagent-driven-development to implement this plan task-by-task.

**Goal:** 修复 GeminiClaw "记忆混乱 / 找不到记忆" 问题——新增统一 `memory_search` 工具（覆盖 daily 文件 + 私人记忆文件 + public_knowledge + chat_messages 历史会话），并接通对话自动落盘 daily 的写链路，让 agent 真正能搜到并持续沉淀记忆。

**Architecture:** 三条修复线。(A) 新增 `memory_search` 只读工具，按关键词跨多数据源检索并按来源分组返回，给所有 agent 用（自注册 + ctx.extra 模式，对齐 list_agents/memory_inspect）。(B) 新增 `MemoryWriter`，在每次对话 `appendMessages` 之后把本轮 user+assistant 摘要追加进当天 daily 文件（全局 daily，私人 daily 视 agentId），幂等 append。(C) memory_search 的 chat_messages 检索分支覆盖全部历史会话，彻底解决"聊过却找不到"。

**Tech Stack:** TypeScript (ESM, `// @ts-nocheck` 风格对齐现有 tools)、better-sqlite3、Vitest、node:fs。所有操作在远程 `pingjiangli@49.232.173.252:6022 ~/Code/GeminiClaw`，编辑用本地写临时文件 + scp + Python 锚点替换脚本模式。

**Execution Config:**
```yaml
confirm_after_each_task: true
skip_spec_review: false
skip_quality_review: false
parallel_tasks: 1
```

**Build Gate:** `pnpm build`（tsc）
**Test:** `npx vitest run <test>`
**Coverage:** `npx vitest run <test> --coverage.enabled --coverage.include="<src>" --coverage.all=false`（增量行覆盖 ≥ 60%）
**Remote DB:** `~/.gemeniclaw/memory/geminiclaw.db`

---

### Task 1: memory_search 工具 — 检索 daily + 私人记忆文件

**Files:**
- Create: `src/tools/memory_search.ts`
- Test: `test/tools/memory_search.test.ts`
- Modify: `src/tools/index.ts`（加 `import './memory_search.js'`）

**Step 1: Write the failing test**

```typescript
import { describe, it, expect, beforeEach } from "vitest"
import { mkdirSync, writeFileSync, rmSync } from "fs"
import { join } from "path"
import "../../src/tools/memory_search.js"
import { registry } from "../../src/tools/registry.js"

const ROOT = "/tmp/gc-ms-test"

describe("memory_search tool", () => {
  beforeEach(() => {
    rmSync(ROOT, { recursive: true, force: true })
    mkdirSync(join(ROOT, "memory", "global", "daily"), { recursive: true })
    mkdirSync(join(ROOT, "agents", "a1", "daily"), { recursive: true })
    writeFileSync(join(ROOT, "memory", "global", "daily", "2026-06-11.md"), "今天讨论了24个线上策略清单 V130")
    writeFileSync(join(ROOT, "agents", "a1", "MEMORY.md"), "私人记忆：腾讯云服务器信号上传")
  })

  it("is registered", () => {
    expect(registry.get("memory_search")).not.toBeNull()
  })

  it("finds keyword in global daily files", async () => {
    const tool = registry.get("memory_search")!
    const res = await tool.handler(
      { query: "24个线上策略" },
      { sessionId: "s", workdir: ".", logger: console, extra: { memoryRoot: ROOT, targetAgentId: "a1" } } as any,
    )
    const text = res.type === "text" ? res.text : JSON.stringify(res)
    expect(text).toContain("V130")
    expect(text).toContain("2026-06-11")
  })

  it("finds keyword in agent private memory files", async () => {
    const tool = registry.get("memory_search")!
    const res = await tool.handler(
      { query: "腾讯云" },
      { sessionId: "s", workdir: ".", logger: console, extra: { memoryRoot: ROOT, targetAgentId: "a1" } } as any,
    )
    const text = res.type === "text" ? res.text : JSON.stringify(res)
    expect(text).toContain("信号上传")
  })

  it("returns a clear message when nothing matches", async () => {
    const tool = registry.get("memory_search")!
    const res = await tool.handler(
      { query: "完全不存在的关键词xyz" },
      { sessionId: "s", workdir: ".", logger: console, extra: { memoryRoot: ROOT, targetAgentId: "a1" } } as any,
    )
    const text = res.type === "text" ? res.text : JSON.stringify(res)
    expect(text).toContain("未找到")
  })
})
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run test/tools/memory_search.test.ts`
Expected: FAIL（registry.get('memory_search') 为 null / 模块不存在）

**Step 3: Write minimal implementation**

```typescript
// @ts-nocheck
// src/tools/memory_search.ts
// Tool: keyword search across all memory sources for any agent.
import { registry } from "./registry.js";
import { readdirSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import os from "os";

interface Hit { source: string; location: string; snippet: string }

function scanFile(path: string, query: string, source: string, location: string, hits: Hit[]): void {
  if (!existsSync(path)) return;
  let content: string;
  try { content = readFileSync(path, "utf-8"); } catch { return; }
  const idx = content.indexOf(query);
  if (idx === -1) return;
  const start = Math.max(0, idx - 40);
  const end = Math.min(content.length, idx + query.length + 80);
  hits.push({ source, location, snippet: content.slice(start, end).replace(/\n+/g, " ") });
}

function scanDir(dir: string, query: string, source: string, hits: Hit[]): void {
  if (!existsSync(dir)) return;
  let files: string[];
  try { files = readdirSync(dir).filter((f) => f.endsWith(".md")); } catch { return; }
  for (const f of files) scanFile(join(dir, f), query, source, f.replace(/\.md$/, ""), hits);
}

registry.register({
  name: "memory_search",
  description:
    "按关键词搜索记忆，覆盖全局日记、当前助手私人记忆、公共知识库以及全部历史会话(chat_messages)。当用户说\"搜索记忆\"\"之前聊过\"\"找一下历史记录\"时调用。",
  schema: {
    type: "object",
    properties: {
      query: { type: "string", description: "要搜索的关键词" },
    },
    required: ["query"],
  },
  handler: async (params, ctx) => {
    const query = String(params.query || "").trim();
    if (!query) return { type: "error", error: "memory_search: query 不能为空" };
    const root = (ctx.extra?.memoryRoot as string) || join(os.homedir(), ".gemeniclaw");
    const targetAgentId = ctx.extra?.targetAgentId as string | undefined;
    const db = ctx.extra?.db;
    const hits: Hit[] = [];

    // 1. global daily + global MEMORY.md
    scanDir(join(root, "memory", "global", "daily"), query, "全局日记", hits);
    scanFile(join(root, "memory", "global", "MEMORY.md"), query, "全局长期记忆", "MEMORY.md", hits);

    // 2. per-agent private memory
    if (targetAgentId) {
      scanFile(join(root, "agents", targetAgentId, "MEMORY.md"), query, "私人长期记忆", "MEMORY.md", hits);
      scanDir(join(root, "agents", targetAgentId, "daily"), query, "私人日记", hits);
    }

    // 3. public_knowledge (DB)
    if (db) {
      try {
        const rows = db.prepare(
          `SELECT id, title, summary FROM public_knowledge WHERE active = 1 AND (title LIKE ? OR summary LIKE ?) LIMIT 10`,
        ).all(`%${query}%`, `%${query}%`) as Array<{ id: string; title: string; summary: string | null }>;
        for (const r of rows) hits.push({ source: "公共知识库", location: r.id, snippet: `${r.title}: ${(r.summary || "").slice(0, 80)}` });
      } catch { /* table may not exist */ }
    }

    // 4. chat_messages history (all sessions)
    if (db) {
      try {
        const rows = db.prepare(
          `SELECT a.agent_name, m.role, substr(m.content, 1, 120) as snippet, m.created_at
           FROM chat_messages m LEFT JOIN agents a ON a.session_id = m.session_id
           WHERE m.content LIKE ? ORDER BY m.created_at DESC LIMIT 15`,
        ).all(`%${query}%`) as Array<{ agent_name: string | null; role: string; snippet: string; created_at: string }>;
        for (const r of rows) hits.push({ source: "历史会话", location: `${r.agent_name || "?"} ${r.created_at} (${r.role})`, snippet: r.snippet.replace(/\n+/g, " ") });
      } catch { /* table may not exist */ }
    }

    if (hits.length === 0) return { type: "text", text: `未找到与「${query}」相关的记忆。` };

    const grouped: Record<string, Hit[]> = {};
    for (const h of hits) (grouped[h.source] ||= []).push(h);
    const out: string[] = [`# 搜索「${query}」共 ${hits.length} 条命中\n`];
    for (const [src, list] of Object.entries(grouped)) {
      out.push(`## ${src}（${list.length}）`);
      for (const h of list) out.push(`- [${h.location}] ${h.snippet}`);
    }
    return { type: "text", text: out.join("\n") };
  },
});
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run test/tools/memory_search.test.ts`
Expected: PASS（4 tests）

**Step 5: Check incremental line coverage**

Run: `npx vitest run test/tools/memory_search.test.ts --coverage.enabled --coverage.include="src/tools/memory_search.ts" --coverage.all=false`
Expected: 增量行覆盖 ≥ 60%

**Step 6: Commit**

```bash
git add src/tools/memory_search.ts test/tools/memory_search.test.ts src/tools/index.ts
git commit -m "feat(memory): add memory_search tool covering daily/private/public/chat history"
```

---

### Task 2: memory_search 覆盖 chat_messages 历史会话（验证 DB 分支）

**Files:**
- Modify: `test/tools/memory_search.test.ts`（追加 DB 检索用例）

> 说明：Task 1 实现已含 chat_messages + public_knowledge 分支，本任务专门补 DB 分支的测试覆盖，确保"聊过却找不到"被真正验证。

**Step 1: Write the failing test**（追加到现有 describe 内）

```typescript
import Database from "better-sqlite3"
import { migrate } from "../../src/db/schema.js"

it("finds keyword in chat_messages history across sessions", async () => {
  const db: any = new Database(":memory:")
  migrate(db)
  db.prepare(`INSERT INTO chat_sessions (id) VALUES ('sess-1')`).run()
  db.prepare(`INSERT INTO agents (id, session_id, template_name, agent_name) VALUES ('ag-1','sess-1','base','龙股助手')`).run()
  db.prepare(`INSERT INTO chat_messages (session_id, role, content) VALUES ('sess-1','user','我给过你24个线上策略的全部明细')`).run()
  const tool = registry.get("memory_search")!
  const res = await tool.handler(
    { query: "24个线上策略" },
    { sessionId: "s", workdir: ".", logger: console, extra: { memoryRoot: ROOT, targetAgentId: "a1", db } } as any,
  )
  const text = res.type === "text" ? res.text : JSON.stringify(res)
  expect(text).toContain("历史会话")
  expect(text).toContain("龙股助手")
})

it("finds keyword in public_knowledge", async () => {
  const db: any = new Database(":memory:")
  migrate(db)
  db.prepare(`INSERT INTO public_knowledge (id, title, summary, active) VALUES ('k1','龙股Agent创建','信号上传腾讯云',1)`).run()
  const tool = registry.get("memory_search")!
  const res = await tool.handler(
    { query: "腾讯云" },
    { sessionId: "s", workdir: ".", logger: console, extra: { memoryRoot: ROOT, targetAgentId: "a1", db } } as any,
  )
  const text = res.type === "text" ? res.text : JSON.stringify(res)
  expect(text).toContain("公共知识库")
})
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run test/tools/memory_search.test.ts`
Expected: 若 Task 1 实现正确，这两条应直接 PASS；若有 SQL 列名不符则 FAIL → 修正实现。

**Step 3: Fix implementation if needed**（仅当失败时调整 SQL/列名）

**Step 4: Run test to verify it passes**

Run: `npx vitest run test/tools/memory_search.test.ts`
Expected: PASS（6 tests 全绿）

**Step 5: Check incremental line coverage**

Run: `npx vitest run test/tools/memory_search.test.ts --coverage.enabled --coverage.include="src/tools/memory_search.ts" --coverage.all=false`
Expected: 增量行覆盖 ≥ 60%（应显著提升，覆盖 DB 两分支）

**Step 6: Commit**

```bash
git add test/tools/memory_search.test.ts
git commit -m "test(memory): cover chat_messages and public_knowledge search branches"
```

---

### Task 3: MemoryWriter — 对话自动落盘 daily

**Files:**
- Create: `src/memory/memory-writer.ts`
- Test: `test/memory/memory-writer.test.ts`

**Step 1: Write the failing test**

```typescript
import { describe, it, expect, beforeEach } from "vitest"
import { rmSync, readFileSync, existsSync } from "fs"
import { join } from "path"
import { MemoryWriter } from "../../src/memory/memory-writer.js"
import { MemoryPaths } from "../../src/memory/paths.js"

const ROOT = "/tmp/gc-mw-test"

describe("MemoryWriter", () => {
  beforeEach(() => { rmSync(ROOT, { recursive: true, force: true }) })

  it("appends a turn summary to today's global daily file", async () => {
    const w = new MemoryWriter(new MemoryPaths(ROOT))
    await w.recordTurn({ userText: "把信号上传腾讯云", assistantText: "已上传完成", date: "2026-06-11" })
    const p = join(ROOT, "memory", "global", "daily", "2026-06-11.md")
    expect(existsSync(p)).toBe(true)
    const content = readFileSync(p, "utf-8")
    expect(content).toContain("信号上传腾讯云")
    expect(content).toContain("已上传完成")
  })

  it("is idempotent-append (multiple turns accumulate, not overwrite)", async () => {
    const w = new MemoryWriter(new MemoryPaths(ROOT))
    await w.recordTurn({ userText: "第一件事", assistantText: "回复一", date: "2026-06-11" })
    await w.recordTurn({ userText: "第二件事", assistantText: "回复二", date: "2026-06-11" })
    const content = readFileSync(join(ROOT, "memory", "global", "daily", "2026-06-11.md"), "utf-8")
    expect(content).toContain("第一件事")
    expect(content).toContain("第二件事")
  })

  it("writes to agent private daily when agentId provided", async () => {
    const w = new MemoryWriter(new MemoryPaths(ROOT))
    await w.recordTurn({ userText: "私人内容", assistantText: "私人回复", date: "2026-06-11", agentId: "a1" })
    const p = join(ROOT, "agents", "a1", "daily", "2026-06-11.md")
    expect(existsSync(p)).toBe(true)
    expect(readFileSync(p, "utf-8")).toContain("私人内容")
  })

  it("truncates very long content to keep daily readable", async () => {
    const w = new MemoryWriter(new MemoryPaths(ROOT))
    await w.recordTurn({ userText: "x".repeat(5000), assistantText: "y".repeat(5000), date: "2026-06-11" })
    const content = readFileSync(join(ROOT, "memory", "global", "daily", "2026-06-11.md"), "utf-8")
    expect(content.length).toBeLessThan(2000)
  })
})
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run test/memory/memory-writer.test.ts`
Expected: FAIL（MemoryWriter 不存在）

**Step 3: Write minimal implementation**

```typescript
// src/memory/memory-writer.ts
import { appendFileSync, mkdirSync } from "fs"
import { dirname } from "path"
import type { MemoryPaths } from "./paths.js"

const MAX_PART = 600 // chars per side

export interface RecordTurnParams {
  userText: string
  assistantText: string
  date: string
  agentId?: string
}

/**
 * Persists each conversation turn into the daily memory file so that
 * memory_search and working-memory injection have real data to draw on.
 * Append-only, idempotent-accumulate, never overwrites.
 */
export class MemoryWriter {
  constructor(private readonly paths: MemoryPaths) {}

  async recordTurn(params: RecordTurnParams): Promise<void> {
    const { userText, assistantText, date, agentId } = params
    const u = this._clip(userText)
    const a = this._clip(assistantText)
    if (!u && !a) return
    const time = new Date().toISOString().slice(11, 16)
    const entry = `\n## ${date} ${time}\n- 用户：${u}\n- 助手：${a}\n`

    const globalPath = this.paths.globalDaily(date)
    this._append(globalPath, entry)

    if (agentId) {
      const agentPath = this.paths.agentDaily(agentId, date)
      this._append(agentPath, entry)
    }
  }

  private _clip(s: string): string {
    const t = (s || "").trim().replace(/\n+/g, " ")
    return t.length > MAX_PART ? t.slice(0, MAX_PART) + "…" : t
  }

  private _append(path: string, entry: string): void {
    mkdirSync(dirname(path), { recursive: true })
    appendFileSync(path, entry, "utf-8")
  }
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run test/memory/memory-writer.test.ts`
Expected: PASS（4 tests）

**Step 5: Check incremental line coverage**

Run: `npx vitest run test/memory/memory-writer.test.ts --coverage.enabled --coverage.include="src/memory/memory-writer.ts" --coverage.all=false`
Expected: 增量行覆盖 ≥ 60%

**Step 6: Commit**

```bash
git add src/memory/memory-writer.ts test/memory/memory-writer.test.ts
git commit -m "feat(memory): add MemoryWriter to persist conversation turns into daily files"
```

---

### Task 4: 接通写链路 — 在 processWithAgent 落盘 + memory_search 注入工具上下文

**Files:**
- Modify: `src/channels/qqbot/index.ts`（processWithAgent 的 appendMessages 之后调用 MemoryWriter；toolContextExtra 已含 db/memoryRoot/targetAgentId，确认 memory_search 可用）

> 说明：本任务为集成接线。memory_search 工具靠 import 自注册并通过 toolContextExtra 注入的 db/memoryRoot/targetAgentId 工作，普通对话的 toolContextExtra（432 行附近）需确认包含这三项；若缺 memoryRoot/targetAgentId 则补上。MemoryWriter 在 appendMessages（约 515 行）之后调用，用 try/catch 包裹避免影响主流程。

**Step 1: Write the failing test**

```typescript
// test/channels/memory-write-wiring.test.ts
import { describe, it, expect } from "vitest"
import { MemoryWriter } from "../../src/memory/memory-writer.js"
import { MemoryPaths } from "../../src/memory/paths.js"
import { rmSync, readFileSync, existsSync } from "fs"
import { join } from "path"

const ROOT = "/tmp/gc-mww-test"

// 集成验证：模拟 processWithAgent 在拿到 reply 后调用 MemoryWriter 的契约
describe("memory write wiring contract", () => {
  it("a turn results in a daily file entry (simulating post-appendMessages hook)", async () => {
    rmSync(ROOT, { recursive: true, force: true })
    const writer = new MemoryWriter(new MemoryPaths(ROOT))
    const content = "用户的问题"
    const reply = "助手的回复"
    const agentId = "ag-x"
    // 这是 index.ts 中将要插入的调用形态
    await writer.recordTurn({
      userText: content,
      assistantText: reply,
      date: new Date().toISOString().slice(0, 10),
      agentId,
    })
    const date = new Date().toISOString().slice(0, 10)
    expect(existsSync(join(ROOT, "memory", "global", "daily", `${date}.md`))).toBe(true)
    expect(existsSync(join(ROOT, "agents", agentId, "daily", `${date}.md`))).toBe(true)
    expect(readFileSync(join(ROOT, "agents", agentId, "daily", `${date}.md`), "utf-8")).toContain("用户的问题")
  })
})
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run test/channels/memory-write-wiring.test.ts`
Expected: FAIL（首次因路径/import 未就绪；修正后 PASS）

**Step 3: Wire MemoryWriter into processWithAgent**

在 `src/channels/qqbot/index.ts` 顶部加 import：
```typescript
import { MemoryWriter } from "../../memory/memory-writer.js"
import { MemoryPaths } from "../../memory/paths.js"
```

模块级单例（靠近 memory/gate 初始化处）：
```typescript
const memoryWriter = new MemoryWriter(new MemoryPaths(process.env.GEMINICLAW_MEMORY_ROOT))
```

在 `processWithAgent` 内 `memory.appendMessages(sessionId, messagesToPersist)`（约 515 行）之后追加：
```typescript
try {
  await memoryWriter.recordTurn({
    userText: content,
    assistantText: reply,
    date: new Date().toISOString().slice(0, 10),
    agentId: targetAgentId,
  })
} catch (e) {
  logger.warn({ err: String(e) }, "memoryWriter.recordTurn failed (non-fatal)")
}
```

确认 `agentLoop.run` 的 `toolContextExtra`（约 432 行）包含 `memoryRoot` 与 `targetAgentId`，缺则补：
```typescript
toolContextExtra: { db, userId, memoryRoot: process.env.GEMINICLAW_MEMORY_ROOT, targetAgentId }
```
（注意：MemoryPaths 默认 root 为 `~/.gemeniclaw`，与运行时一致；若服务用自定义 root 须经 env 统一。）

**Step 4: Run test to verify it passes**

Run: `npx vitest run test/channels/memory-write-wiring.test.ts`
Expected: PASS

**Step 5: Build gate（确认接线不破坏类型）**

Run: `pnpm build`
Expected: tsc 通过，0 error

**Step 6: Commit**

```bash
git add src/channels/qqbot/index.ts test/channels/memory-write-wiring.test.ts
git commit -m "feat(memory): wire MemoryWriter into processWithAgent and expose memoryRoot/targetAgentId to tools"
```

---

### Task 5: 全量回归 + 真机冒烟验证

**Files:** 无源码改动（验证任务）

**Step 1: 全量测试**

Run: `npx vitest run`
Expected: 全绿（原有 431+ 新增用例）

**Step 2: Build gate**

Run: `pnpm build`
Expected: 0 error

**Step 3: 重启服务并冒烟**

```bash
# 远程：优雅停旧进程后重启
pkill -f "tsx src/index.ts" || true
nohup npm exec tsx src/index.ts >> /tmp/gemini.log 2>&1 &
sleep 5
curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:18790/v1/health   # 期望 200
tail -n 30 /tmp/gemini.log   # 期望 "Memory strategy: layered" + QQBot WebSocket READY
```

**Step 4: 真机记忆闭环验证**

通过 QQ 与某 agent 对话一轮（如"记住：信号上传腾讯云已完成"），随后：
```bash
# 确认 daily 落盘
ls -la ~/.gemeniclaw/memory/global/daily/
cat ~/.gemeniclaw/memory/global/daily/$(date +%F).md   # 应含本轮 user/assistant
```
再对话触发 `memory_search`（如"搜索一下腾讯云"），确认 agent 能返回命中（覆盖 daily + chat_messages）。

**Step 5: 验证 chat_messages 历史可被搜到**

针对历史已存在但未落盘 daily 的话题（如"24个线上策略"）触发 memory_search，确认从 chat_messages 分支命中——这是"聊过却找不到"问题的最终验证。

**Step 6: Commit（如有验证脚本或文档微调）**

```bash
git add -A && git commit -m "chore(memory): verification notes for memory_search & persistence" || echo "nothing to commit"
```

---

## 完成标准

- [ ] memory_search 工具上线，覆盖 4 类来源：全局 daily/MEMORY.md、私人 daily/MEMORY.md、public_knowledge、chat_messages 全历史
- [ ] 每轮对话自动落盘当天 daily（全局 + 私人）
- [ ] 全量测试绿、build 绿、增量覆盖均 ≥ 60%
- [ ] 真机：落盘可见 + memory_search 能命中 daily 与历史会话
- [ ] 每个 Task 独立 commit（远程仓库）
