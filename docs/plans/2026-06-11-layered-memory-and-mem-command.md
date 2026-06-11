# 记忆分层架构重构 + /mem 记忆管理功能 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use super-assistant:subagent-driven-development to implement this plan task-by-task.

**Goal:** 重构记忆系统为「工作记忆 / 离线记忆」两层模型，新增 per-agent 私人记忆隔离，并实现 `/mem` 命令进入隔离式记忆管理会话。

**Architecture:**
记忆分为两大类。**工作记忆（Working Memory）** 是每轮注入 LLM context 的内容，由「全局记忆」（所有 agent 共享，含不可压缩固定区 AGENT.md + 可压缩非固定区全局长期记忆）和「私人记忆」（每个 agent 独立，含不可压缩固定区 agent 描述 + 可压缩非固定区 agent 长期记忆/当日日记）组成。**离线记忆（Offline Memory）** 是已落盘的持久化数据：全局长期记忆文件、per-agent 长期记忆/当日日记文件、以及跨 agent 共享的公共知识库（原 `memory_topics` 改名为 `public_knowledge`）。`/mem` 命令让用户进入一个隔离的临时会话，由专职「记忆管家」Agent 用工具读写各记忆层，调整内容不污染原助手对话历史。

**Tech Stack:** TypeScript (ESM) + Node.js + better-sqlite3 + Fastify + Vitest，代码库位于远程服务器 `pingjiangli@49.232.173.252:~/Code/GeminiClaw`（SSH 端口 6022）。所有改动与测试都在远程执行。

**Execution Config:**
```yaml
confirm_after_each_task: true     # 涉及 DB schema 与线上记忆数据，逐任务确认
skip_spec_review: false
skip_quality_review: false
parallel_tasks: 1
```

---

## 关键背景（实施者必读）

**代码库不在本地。** lipingjiang 的本地工作区 `/Users/lipingjiang/Codes/GeminiClaw` 是一个旧镜像，真正运行的代码在远程服务器。所有 `read/edit/exec/build/test` 都要通过 SSH：
```
ssh -p 6022 pingjiangli@49.232.173.252 "cd ~/Code/GeminiClaw && <command>"
```
数据库：`/Users/pingjiangli/.gemeniclaw/memory/geminiclaw.db`（SQLite）
数据目录：`/Users/pingjiangli/.gemeniclaw/`

**当前记忆系统现状（重构前）：**
- 全局固定：`~/.gemeniclaw/AGENT.md`（系统 prompt，由 `strategy.ts:loadSystemPrompt()` 读取）
- 全局非固定（当前误放在「固定」语义里）：`~/.gemeniclaw/.workspace/MEMORY.md` + `~/.gemeniclaw/.workspace/memory/{date}.md`，由 `layered.ts:loadWorkspaceMemory()` 每轮注入
- 公共知识：`memory_topics` 表（无 agent_id，所有 agent 共享，目前仅 4 条记录），由 `triage` 立项 + `background` 摘要写入
- per-session：`chat_messages`（session 与 agent 1:1）
- agent 固定身份：`agents.description` 字段（一段短文本），在 `qqbot/index.ts:203-213` 注入为 system 消息

**重构后目标分层：**

| 大类 | 子类 | 区 | 可压缩 | 存储位置 |
|------|------|----|----|----|
| 工作记忆 | 全局记忆 | 固定区 | ❌ | `~/.gemeniclaw/AGENT.md` |
| 工作记忆 | 全局记忆 | 非固定区 | ✅ | `~/.gemeniclaw/memory/global/MEMORY.md` + `daily/{date}.md` |
| 工作记忆 | 私人记忆 | 固定区 | ❌ | `~/.gemeniclaw/agents/{agent_id}/AGENT.md`（新） |
| 工作记忆 | 私人记忆 | 非固定区 | ✅ | `~/.gemeniclaw/agents/{agent_id}/MEMORY.md` + `daily/{date}.md`（新） |
| 离线记忆 | 公共知识库 | — | ✅（已有 compact/evict） | `public_knowledge` 表（原 `memory_topics` 改名） |

**冷启动规则（新 agent 第一次创建）：** 私人非固定区为空 → 只加载全局长期记忆（全局 MEMORY.md + 全局当日日记），不主动读其他 agent 的日记；用户明确要求时才通过工具去读取指定 agent 的记忆。

---

## Stage 0：准备与基线

### Task 0: 建立基线、确认测试可跑

**Files:** 无（只读验证）

**Step 1: 确认远程代码可构建、测试全绿**

Run:
```bash
ssh -p 6022 pingjiangli@49.232.173.252 "cd ~/Code/GeminiClaw && pnpm build 2>&1 | tail -5 && pnpm test 2>&1 | tail -15"
```
Expected: build 无错误，vitest 全部通过（记录当前通过数作为基线）

**Step 2: 备份数据库**

Run:
```bash
ssh -p 6022 pingjiangli@49.232.173.252 "cp /Users/pingjiangli/.gemeniclaw/memory/geminiclaw.db /Users/pingjiangli/.gemeniclaw/memory/geminiclaw.db.bak-$(date +%Y%m%d-%H%M%S)"
```
Expected: 备份文件生成（schema 改动前的安全网）

**Step 3: 确认 git 工作区干净**

Run: `ssh -p 6022 pingjiangli@49.232.173.252 "cd ~/Code/GeminiClaw && git status --short && git log --oneline -3"`
Expected: 干净或已知改动，记录当前 HEAD

---

## Stage 1：记忆路径抽象层（先建抽象，后改 schema）

### Task 1: 提取记忆路径解析模块 MemoryPaths

> 把散落在 `strategy.ts` 和 `layered.ts` 里的硬编码路径集中到一处，为 per-agent 路径打基础。DRY。

**Files:**
- Create: `src/memory/paths.ts`
- Test: `test/memory/paths.test.ts`

**Step 1: Write the failing test**

```typescript
// test/memory/paths.test.ts
import { describe, it, expect } from "vitest"
import { MemoryPaths } from "../../src/memory/paths.js"

describe("MemoryPaths", () => {
  const root = "/tmp/gc-test"
  const mp = new MemoryPaths(root)

  it("resolves global fixed prompt (AGENT.md)", () => {
    expect(mp.globalAgentMd()).toBe("/tmp/gc-test/AGENT.md")
  })

  it("resolves global long-term memory", () => {
    expect(mp.globalMemoryMd()).toBe("/tmp/gc-test/memory/global/MEMORY.md")
  })

  it("resolves global daily note by date", () => {
    expect(mp.globalDaily("2026-06-11")).toBe("/tmp/gc-test/memory/global/daily/2026-06-11.md")
  })

  it("resolves per-agent fixed prompt", () => {
    expect(mp.agentAgentMd("abc")).toBe("/tmp/gc-test/agents/abc/AGENT.md")
  })

  it("resolves per-agent long-term memory", () => {
    expect(mp.agentMemoryMd("abc")).toBe("/tmp/gc-test/agents/abc/MEMORY.md")
  })

  it("resolves per-agent daily note", () => {
    expect(mp.agentDaily("abc", "2026-06-11")).toBe("/tmp/gc-test/agents/abc/daily/2026-06-11.md")
  })
})
```

**Step 2: Run test to verify it fails**

Run: `ssh -p 6022 pingjiangli@49.232.173.252 "cd ~/Code/GeminiClaw && npx vitest run test/memory/paths.test.ts"`
Expected: FAIL（找不到 MemoryPaths 模块）

**Step 3: Write minimal implementation**

```typescript
// src/memory/paths.ts
import { join } from "path"
import os from "os"

/** Centralized resolver for all memory storage paths.
 *  Default root: ~/.gemeniclaw */
export class MemoryPaths {
  constructor(private root: string = join(os.homedir(), ".gemeniclaw")) {}

  // ── Global fixed (system prompt, never compacted) ──
  globalAgentMd(): string {
    return join(this.root, "AGENT.md")
  }

  // ── Global non-fixed (compressible long-term + daily) ──
  globalMemoryMd(): string {
    return join(this.root, "memory", "global", "MEMORY.md")
  }
  globalDaily(date: string): string {
    return join(this.root, "memory", "global", "daily", `${date}.md`)
  }
  globalDailyDir(): string {
    return join(this.root, "memory", "global", "daily")
  }

  // ── Per-agent fixed (agent's own AGENT.md, never compacted) ──
  agentAgentMd(agentId: string): string {
    return join(this.root, "agents", agentId, "AGENT.md")
  }

  // ── Per-agent non-fixed (compressible) ──
  agentMemoryMd(agentId: string): string {
    return join(this.root, "agents", agentId, "MEMORY.md")
  }
  agentDaily(agentId: string, date: string): string {
    return join(this.root, "agents", agentId, "daily", `${date}.md`)
  }
  agentDailyDir(agentId: string): string {
    return join(this.root, "agents", agentId, "daily")
  }
  agentDir(agentId: string): string {
    return join(this.root, "agents", agentId)
  }
}
```

**Step 4: Run test to verify it passes**

Run: `ssh -p 6022 pingjiangli@49.232.173.252 "cd ~/Code/GeminiClaw && npx vitest run test/memory/paths.test.ts"`
Expected: PASS（6 tests）

**Step 5: Check incremental line coverage**

Run: `ssh -p 6022 pingjiangli@49.232.173.252 "cd ~/Code/GeminiClaw && npx vitest run --coverage test/memory/paths.test.ts 2>&1 | grep paths.ts"`
Expected: paths.ts 行覆盖 ≥ 60%

**Step 6: Commit**

```bash
ssh -p 6022 pingjiangli@49.232.173.252 "cd ~/Code/GeminiClaw && git add src/memory/paths.ts test/memory/paths.test.ts && git commit -m 'feat(memory): add MemoryPaths resolver for layered storage'"
```

---

## Stage 2：DB schema 重构（改名 + per-agent 支持）

### Task 2: 重命名 memory_topics → public_knowledge

> 语义对齐：它是跨 agent 共享的「公共知识库」。用兼容性迁移：建新表 + 数据迁移 + 旧表保留 view 兜底。

**Files:**
- Modify: `src/db/schema.ts:26-41`
- Create: `db/migrations/V20260611_001__rename_memory_topics_to_public_knowledge.sql`
- Test: `test/db/migrate-public-knowledge.test.ts`

**DB Changes:**
- DDL: `db/migrations/V20260611_001__rename_memory_topics_to_public_knowledge.sql`
- Type: `CREATE TABLE` + `INSERT ... SELECT`（数据迁移）+ 兼容性 `CREATE VIEW memory_topics`
- Compatibility: `requires-migration-before-deploy`（表名变更，但保留同名 view 做读兜底，写路径需同步改）
- Rollback: `DROP VIEW memory_topics; ALTER TABLE public_knowledge RENAME TO memory_topics;`

> ⚠️ DDL migration file MUST be committed together with the application code in the same commit.

**Step 1: Write the failing test**

```typescript
// test/db/migrate-public-knowledge.test.ts
import { describe, it, expect } from "vitest"
import Database from "better-sqlite3"
import { migrate } from "../../src/db/schema.js"

describe("public_knowledge migration", () => {
  it("creates public_knowledge table with same columns as old memory_topics", () => {
    const db = new Database(":memory:") as any
    migrate(db)
    const cols = db.prepare(`PRAGMA table_info(public_knowledge)`).all() as Array<{ name: string }>
    const names = cols.map((c) => c.name)
    expect(names).toContain("id")
    expect(names).toContain("title")
    expect(names).toContain("summary")
    expect(names).toContain("doc_level2")
    expect(names).toContain("active")
  })

  it("keeps memory_topics readable as a compatibility view/table", () => {
    const db = new Database(":memory:") as any
    migrate(db)
    // should not throw
    const rows = db.prepare(`SELECT id FROM memory_topics LIMIT 1`).all()
    expect(Array.isArray(rows)).toBe(true)
  })
})
```

**Step 2: Run test to verify it fails**

Run: `ssh -p 6022 pingjiangli@49.232.173.252 "cd ~/Code/GeminiClaw && npx vitest run test/db/migrate-public-knowledge.test.ts"`
Expected: FAIL（no such table: public_knowledge）

**Step 3: Write minimal implementation**

在 `src/db/schema.ts` 的 `migrate()` 中，把原 `memory_topics` 定义改为 `public_knowledge`，并加一个兼容 view：

```sql
CREATE TABLE IF NOT EXISTS public_knowledge (
  id               TEXT PRIMARY KEY,
  title            TEXT NOT NULL,
  summary          TEXT,
  doc_level2       TEXT,
  doc_level3       TEXT,
  doc_size         INTEGER NOT NULL DEFAULT 0,
  active           INTEGER NOT NULL DEFAULT 1,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now')),
  last_accessed_at TEXT NOT NULL DEFAULT (datetime('now')),
  access_count     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_public_knowledge_active
  ON public_knowledge(active, last_accessed_at);
```

迁移文件 `db/migrations/V20260611_001__rename_memory_topics_to_public_knowledge.sql`：
```sql
-- 仅对已有线上库执行（migrate() 内对 :memory: 用 CREATE TABLE IF NOT EXISTS 即可）
CREATE TABLE IF NOT EXISTS public_knowledge AS SELECT * FROM memory_topics;
DROP TABLE IF EXISTS memory_topics;
CREATE VIEW IF NOT EXISTS memory_topics AS SELECT * FROM public_knowledge;
```

> 注意：测试用内存库走 `migrate()` 的 `CREATE TABLE IF NOT EXISTS public_knowledge` + `CREATE VIEW IF NOT EXISTS memory_topics AS SELECT * FROM public_knowledge`，两条都加进 `migrate()`，保证测试和线上一致。

**Step 4: Run test to verify it passes**

Run: `ssh -p 6022 pingjiangli@49.232.173.252 "cd ~/Code/GeminiClaw && npx vitest run test/db/migrate-public-knowledge.test.ts"`
Expected: PASS（2 tests）

**Step 5: Update all code references**

把代码中所有 `memory_topics` 的**写**引用改为 `public_knowledge`（读可暂留 view，但建议一并改）：
- `src/memory/strategies/layered.ts`（5 处：getContext 查询、UPDATE 访问记录、appendTurn 查询/INSERT）
- `src/memory/background.ts`（appendToTopic / evictIfNeeded 共 4 处）
- `src/memory/triage.ts`（若有引用）

Run grep 确认无遗漏：
```bash
ssh -p 6022 pingjiangli@49.232.173.252 "cd ~/Code/GeminiClaw && grep -rn 'memory_topics' src/"
```
Expected: 仅剩兼容 view 定义那一处（schema.ts），其余全改为 public_knowledge

**Step 6: Run full build + tests**

Run: `ssh -p 6022 pingjiangli@49.232.173.252 "cd ~/Code/GeminiClaw && pnpm build 2>&1 | tail -3 && pnpm test 2>&1 | tail -10"`
Expected: build ok，测试全绿（不低于基线）

**Step 7: Commit**

```bash
ssh -p 6022 pingjiangli@49.232.173.252 "cd ~/Code/GeminiClaw && git add src/db/schema.ts db/migrations/ src/memory/ test/db/ && git commit -m 'refactor(db): rename memory_topics to public_knowledge with compat view'"
```

---

### Task 3: 新增 agent_memory 表（per-agent 私人非固定记忆元数据）

> 私人长期记忆/日记主体存文件（便于人读、便于压缩），但需要一张表记录每个 agent 的记忆元信息（是否首次创建、最后压缩时间等），并支持冷启动判断。

**Files:**
- Modify: `src/db/schema.ts`
- Test: `test/db/agent-memory-schema.test.ts`

**DB Changes:**
- DDL: 同上迁移文件追加，或新建 `V20260611_002__add_agent_memory.sql`
- Type: `CREATE TABLE agent_memory`
- Compatibility: `backward-compatible`（纯新增表）
- Rollback: `DROP TABLE agent_memory;`

**Step 1: Write the failing test**

```typescript
// test/db/agent-memory-schema.test.ts
import { describe, it, expect } from "vitest"
import Database from "better-sqlite3"
import { migrate } from "../../src/db/schema.js"

describe("agent_memory table", () => {
  it("has agent_id PK and bootstrap tracking columns", () => {
    const db = new Database(":memory:") as any
    migrate(db)
    const cols = (db.prepare(`PRAGMA table_info(agent_memory)`).all() as Array<{ name: string }>).map(c => c.name)
    expect(cols).toContain("agent_id")
    expect(cols).toContain("bootstrapped")     // 0/1：是否已完成首次冷启动
    expect(cols).toContain("memory_size")      // MEMORY.md 字节数
    expect(cols).toContain("last_compacted_at")
  })
})
```

**Step 2: Run test to verify it fails**

Run: `ssh -p 6022 pingjiangli@49.232.173.252 "cd ~/Code/GeminiClaw && npx vitest run test/db/agent-memory-schema.test.ts"`
Expected: FAIL（no such table: agent_memory）

**Step 3: Write minimal implementation**

`migrate()` 追加：
```sql
CREATE TABLE IF NOT EXISTS agent_memory (
  agent_id          TEXT PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
  bootstrapped      INTEGER NOT NULL DEFAULT 0,
  memory_size       INTEGER NOT NULL DEFAULT 0,
  last_compacted_at TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
```

**Step 4: Run test to verify it passes**

Run: `ssh -p 6022 pingjiangli@49.232.173.252 "cd ~/Code/GeminiClaw && npx vitest run test/db/agent-memory-schema.test.ts"`
Expected: PASS

**Step 5: Check coverage** → schema.ts 改动行覆盖 ≥ 60%（由两个 schema 测试共同覆盖）

**Step 6: Commit**

```bash
ssh -p 6022 pingjiangli@49.232.173.252 "cd ~/Code/GeminiClaw && git add src/db/schema.ts db/migrations/ test/db/ && git commit -m 'feat(db): add agent_memory table for per-agent private memory metadata'"
```

---

## Stage 3：工作记忆组装重构（per-agent 注入）

### Task 4: WorkingMemoryBuilder —— 组装四区工作记忆

> 把「全局固定 + 全局非固定 + 私人固定 + 私人非固定」的加载逻辑收敛到一个可测的纯函数模块。替代现有 `loadWorkspaceMemory()` 的全局-only 逻辑。

**Files:**
- Create: `src/memory/working-memory.ts`
- Test: `test/memory/working-memory.test.ts`

**Step 1: Write the failing test**

```typescript
// test/memory/working-memory.test.ts
import { describe, it, expect, beforeEach } from "vitest"
import { mkdirSync, writeFileSync, rmSync } from "fs"
import { join } from "path"
import { MemoryPaths } from "../../src/memory/paths.js"
import { WorkingMemoryBuilder } from "../../src/memory/working-memory.js"

const ROOT = "/tmp/gc-wm-test"

describe("WorkingMemoryBuilder", () => {
  beforeEach(() => {
    rmSync(ROOT, { recursive: true, force: true })
    mkdirSync(join(ROOT, "memory", "global", "daily"), { recursive: true })
    mkdirSync(join(ROOT, "agents", "a1", "daily"), { recursive: true })
    writeFileSync(join(ROOT, "AGENT.md"), "GLOBAL FIXED")
    writeFileSync(join(ROOT, "memory", "global", "MEMORY.md"), "GLOBAL LTM")
    writeFileSync(join(ROOT, "agents", "a1", "AGENT.md"), "AGENT FIXED")
    writeFileSync(join(ROOT, "agents", "a1", "MEMORY.md"), "AGENT LTM")
  })

  it("assembles all four layers for a given agent", () => {
    const wm = new WorkingMemoryBuilder(new MemoryPaths(ROOT))
    const result = wm.build("a1", "2026-06-11")
    // 固定区
    expect(result.globalFixed).toContain("GLOBAL FIXED")
    expect(result.agentFixed).toContain("AGENT FIXED")
    // 非固定区
    expect(result.globalNonFixed).toContain("GLOBAL LTM")
    expect(result.agentNonFixed).toContain("AGENT LTM")
  })

  it("falls back to global-only when agent has no private memory (cold start)", () => {
    const wm = new WorkingMemoryBuilder(new MemoryPaths(ROOT))
    const result = wm.build("unknown-agent", "2026-06-11")
    expect(result.globalFixed).toContain("GLOBAL FIXED")
    expect(result.globalNonFixed).toContain("GLOBAL LTM")
    expect(result.agentFixed).toBe("")
    expect(result.agentNonFixed).toBe("")
  })

  it("renders combined system prompt with section headers", () => {
    const wm = new WorkingMemoryBuilder(new MemoryPaths(ROOT))
    const text = wm.renderSystemPrompt("a1", "2026-06-11", "助手")
    expect(text).toContain("GLOBAL FIXED")
    expect(text).toContain("AGENT FIXED")
    expect(text).toContain("AGENT LTM")
  })
})
```

**Step 2: Run test to verify it fails**

Run: `ssh -p 6022 pingjiangli@49.232.173.252 "cd ~/Code/GeminiClaw && npx vitest run test/memory/working-memory.test.ts"`
Expected: FAIL（找不到 WorkingMemoryBuilder）

**Step 3: Write minimal implementation**

```typescript
// src/memory/working-memory.ts
import { existsSync, readFileSync } from "fs"
import type { MemoryPaths } from "./paths.js"

export interface WorkingMemory {
  globalFixed: string      // AGENT.md（全局）
  globalNonFixed: string   // 全局 MEMORY.md + 全局当日日记
  agentFixed: string       // agent AGENT.md（私人固定）
  agentNonFixed: string    // agent MEMORY.md + 当日日记（私人非固定）
}

function readIf(path: string): string {
  return existsSync(path) ? readFileSync(path, "utf-8").trim() : ""
}

export class WorkingMemoryBuilder {
  constructor(private paths: MemoryPaths) {}

  build(agentId: string, date: string): WorkingMemory {
    const globalFixed = readIf(this.paths.globalAgentMd())

    const globalLtm = readIf(this.paths.globalMemoryMd())
    const globalToday = readIf(this.paths.globalDaily(date))
    const globalNonFixed = [globalLtm, globalToday].filter(Boolean).join("\n\n")

    const agentFixed = readIf(this.paths.agentAgentMd(agentId))
    const agentLtm = readIf(this.paths.agentMemoryMd(agentId))
    const agentToday = readIf(this.paths.agentDaily(agentId, date))
    const agentNonFixed = [agentLtm, agentToday].filter(Boolean).join("\n\n")

    return { globalFixed, globalNonFixed, agentFixed, agentNonFixed }
  }

  /** 渲染成可直接拼进 systemPrompt 的文本（带分区标题）。 */
  renderSystemPrompt(agentId: string, date: string, agentName: string): string {
    const wm = this.build(agentId, date)
    const parts: string[] = []
    if (wm.globalFixed) parts.push(wm.globalFixed)
    if (wm.agentFixed) {
      parts.push(`## 当前助手身份（${agentName}）\n${wm.agentFixed}`)
    }
    const nonFixed: string[] = []
    if (wm.globalNonFixed) nonFixed.push(`### 全局长期记忆\n${wm.globalNonFixed}`)
    if (wm.agentNonFixed) nonFixed.push(`### 本助手记忆\n${wm.agentNonFixed}`)
    if (nonFixed.length > 0) {
      parts.push(`---\n\n## 记忆\n${nonFixed.join("\n\n")}`)
    }
    return parts.join("\n\n")
  }
}
```

**Step 4: Run test to verify it passes**

Run: `ssh -p 6022 pingjiangli@49.232.173.252 "cd ~/Code/GeminiClaw && npx vitest run test/memory/working-memory.test.ts"`
Expected: PASS（3 tests）

**Step 5: Check coverage** → working-memory.ts 行覆盖 ≥ 60%

**Step 6: Commit**

```bash
ssh -p 6022 pingjiangli@49.232.173.252 "cd ~/Code/GeminiClaw && git add src/memory/working-memory.ts test/memory/working-memory.test.ts && git commit -m 'feat(memory): add WorkingMemoryBuilder assembling four memory layers'"
```

---

### Task 5: LayeredStrategy 接入 WorkingMemoryBuilder（按 agent 注入）

> 让 `getContext` 能根据当前 agentId 注入私人记忆。`getContext(sessionId, userMessage)` 签名增加可选 `agentId`，保持向后兼容。

**Files:**
- Modify: `src/memory/strategy.ts`（MemoryStrategy 接口增加可选 agentId 参数）
- Modify: `src/memory/strategies/layered.ts`（用 WorkingMemoryBuilder 替换 loadWorkspaceMemory）
- Modify: `src/channels/qqbot/index.ts`（getContext 传入 agentId，移除重复的身份注入逻辑）
- Test: `test/memory/layered-agent-context.test.ts`

**Step 1: Write the failing test**

```typescript
// test/memory/layered-agent-context.test.ts
import { describe, it, expect, beforeEach } from "vitest"
import Database from "better-sqlite3"
import { mkdirSync, writeFileSync, rmSync } from "fs"
import { join } from "path"
import { migrate } from "../../src/db/schema.js"
import { LayeredStrategy } from "../../src/memory/strategies/layered.js"

const ROOT = "/tmp/gc-layered-test"

// fake provider that returns empty route/triage
const fakeProvider: any = {
  name: "fake",
  chat: async () => ({ content: '{"matches":[]}' }),
  stream: async function* () {},
}

describe("LayeredStrategy per-agent context", () => {
  let db: any
  beforeEach(() => {
    rmSync(ROOT, { recursive: true, force: true })
    mkdirSync(join(ROOT, "agents", "a1"), { recursive: true })
    writeFileSync(join(ROOT, "agents", "a1", "MEMORY.md"), "PRIVATE_MARKER_XYZ")
    db = new Database(":memory:")
    migrate(db)
  })

  it("injects current agent private memory into system prompt", async () => {
    const strat = new LayeredStrategy({
      db, routerProvider: fakeProvider, triageProvider: fakeProvider,
      systemPrompt: "BASE", recentMessageLimit: 10, triageAfterTurns: 99,
      compactThresholdBytes: 99999, maxActiveTopics: 16,
      memoryRoot: ROOT, // 新增配置项
    } as any)
    const ctx = await strat.getContext("s1", "hello", "a1")
    const sysMsg = ctx.messages.find((m) => m.role === "system")!
    expect(String(sysMsg.content)).toContain("PRIVATE_MARKER_XYZ")
  })
})
```

**Step 2: Run test to verify it fails**

Run: `ssh -p 6022 pingjiangli@49.232.173.252 "cd ~/Code/GeminiClaw && npx vitest run test/memory/layered-agent-context.test.ts"`
Expected: FAIL（getContext 不接受第三参 / 未注入私人记忆）

**Step 3: Write minimal implementation**

1. `src/memory/strategy.ts` 接口改为：
```typescript
getContext(sessionId: string, userMessage: string, agentId?: string): Promise<ConversationContext>
```

2. `src/memory/strategies/layered.ts`：
- 构造函数 config 增加 `memoryRoot?: string`
- 内部 `private wm: WorkingMemoryBuilder`（用 `new MemoryPaths(config.memoryRoot)`）
- `getContext(sessionId, userMessage, agentId?)`：把 `loadWorkspaceMemory()` 替换为：
```typescript
const date = new Date().toISOString().slice(0, 10)
const workspaceMem = agentId
  ? "\n\n" + this.wm.renderSystemPrompt(agentId, date, /*agentName*/ "")
  : "\n\n" + this.wm.renderGlobalOnly(date) // 无 agent 时仅全局
```
（给 WorkingMemoryBuilder 补一个 `renderGlobalOnly(date)` 方法，逻辑同 renderSystemPrompt 但跳过 agent 区。）

3. `src/channels/qqbot/index.ts`：
- `processWithAgent` 中调用 `memory.getContext(sessionId, content, agentId ?? undefined)`
- **移除** 203-213 行手工查 agents 表注入 `agentIdentityMsg` 的逻辑（已由 WorkingMemoryBuilder 的 agentFixed 区承担）；但保留 `currentAgentDisplayName` 用于回复前缀（从 agents 表查 agent_name 即可）

> 兼容性：旧的全局 MEMORY.md 路径 `~/.gemeniclaw/.workspace/MEMORY.md` 需迁移到 `~/.gemeniclaw/memory/global/MEMORY.md`（见 Task 8 数据迁移）。在迁移完成前，WorkingMemoryBuilder 可临时同时探测两个路径，迁移后删除旧探测。

**Step 4: Run test to verify it passes**

Run: `ssh -p 6022 pingjiangli@49.232.173.252 "cd ~/Code/GeminiClaw && npx vitest run test/memory/layered-agent-context.test.ts"`
Expected: PASS

**Step 5: Full build + tests**

Run: `ssh -p 6022 pingjiangli@49.232.173.252 "cd ~/Code/GeminiClaw && pnpm build 2>&1 | tail -3 && pnpm test 2>&1 | tail -10"`
Expected: build ok，测试不低于基线

**Step 6: Commit**

```bash
ssh -p 6022 pingjiangli@49.232.173.252 "cd ~/Code/GeminiClaw && git add src/memory/ src/channels/qqbot/index.ts test/memory/ && git commit -m 'feat(memory): inject per-agent private memory via WorkingMemoryBuilder'"
```

---

## Stage 4：记忆读写工具（供记忆管家 Agent 使用）

### Task 6: memory_inspect 工具（只读全景）

> 让 Agent 能查看各记忆层的内容与大小。沿用 list_agents.ts 的自注册 + ctx.extra 模式。

**Files:**
- Create: `src/tools/memory_inspect.ts`
- Modify: `src/tools/index.ts`（追加 import）
- Test: `test/tools/memory_inspect.test.ts`

**Step 1: Write the failing test**

```typescript
// test/tools/memory_inspect.test.ts
import { describe, it, expect, beforeEach } from "vitest"
import { mkdirSync, writeFileSync, rmSync } from "fs"
import { join } from "path"
import "../../src/tools/memory_inspect.js"
import { registry } from "../../src/tools/registry.js"

const ROOT = "/tmp/gc-mi-test"

describe("memory_inspect tool", () => {
  beforeEach(() => {
    rmSync(ROOT, { recursive: true, force: true })
    mkdirSync(join(ROOT, "agents", "a1"), { recursive: true })
    writeFileSync(join(ROOT, "AGENT.md"), "GLOBAL")
    writeFileSync(join(ROOT, "agents", "a1", "MEMORY.md"), "AGENT_LTM_CONTENT")
  })

  it("is registered", () => {
    expect(registry.get("memory_inspect")).not.toBeNull()
  })

  it("returns overview of all memory layers for target agent", async () => {
    const tool = registry.get("memory_inspect")!
    const res = await tool.handler({ layer: "all" }, {
      sessionId: "s", workdir: ".", logger: console,
      extra: { memoryRoot: ROOT, targetAgentId: "a1" },
    } as any)
    const text = res.type === "text" ? res.text : JSON.stringify(res)
    expect(text).toContain("AGENT_LTM_CONTENT")
  })
})
```

**Step 2: Run test to verify it fails**

Run: `ssh -p 6022 pingjiangli@49.232.173.252 "cd ~/Code/GeminiClaw && npx vitest run test/tools/memory_inspect.test.ts"`
Expected: FAIL

**Step 3: Write minimal implementation**

```typescript
// @ts-nocheck
// src/tools/memory_inspect.ts
import { registry } from "./registry.js"
import { MemoryPaths } from "../memory/paths.js"
import { WorkingMemoryBuilder } from "../memory/working-memory.js"

registry.register({
  name: "memory_inspect",
  description: "查看记忆全景：全局固定区(AGENT.md)、全局非固定区(长期记忆/日记)、当前助手私人固定区、私人非固定区，以及公共知识库。layer 可选 all/global_fixed/global_nonfixed/agent_fixed/agent_nonfixed/public。仅在记忆管理会话中使用。",
  schema: {
    type: "object",
    properties: {
      layer: { type: "string", description: "要查看的层，默认 all" },
    },
    required: [],
  },
  handler: async (params, ctx) => {
    const root = ctx.extra?.memoryRoot as string | undefined
    const targetAgentId = ctx.extra?.targetAgentId as string | undefined
    const db = ctx.extra?.db
    const paths = new MemoryPaths(root)
    const wm = new WorkingMemoryBuilder(paths)
    const date = new Date().toISOString().slice(0, 10)
    const mem = targetAgentId ? wm.build(targetAgentId, date) : wm.build("__none__", date)

    const layer = (params.layer as string) || "all"
    const sections: string[] = []
    const want = (k: string) => layer === "all" || layer === k

    if (want("global_fixed")) sections.push(`# 全局固定区（不可压缩）\n${mem.globalFixed || "(空)"}`)
    if (want("global_nonfixed")) sections.push(`# 全局非固定区（可压缩）\n${mem.globalNonFixed || "(空)"}`)
    if (want("agent_fixed")) sections.push(`# 私人固定区（不可压缩）\n${mem.agentFixed || "(空)"}`)
    if (want("agent_nonfixed")) sections.push(`# 私人非固定区（可压缩）\n${mem.agentNonFixed || "(空)"}`)
    if (want("public") && db) {
      const rows = db.prepare(`SELECT id, title, doc_size FROM public_knowledge WHERE active = 1 ORDER BY last_accessed_at DESC`).all()
      const list = rows.map((r) => `- [${r.id}] ${r.title}（${r.doc_size}B）`).join("\n")
      sections.push(`# 公共知识库\n${list || "(空)"}`)
    }
    return { type: "text", text: sections.join("\n\n---\n\n") }
  },
})
```

`src/tools/index.ts` 追加：`import './memory_inspect.js';`

**Step 4: Run test to verify it passes** → PASS（2 tests）

**Step 5: Coverage** → memory_inspect.ts 行覆盖 ≥ 60%

**Step 6: Commit**

```bash
ssh -p 6022 pingjiangli@49.232.173.252 "cd ~/Code/GeminiClaw && git add src/tools/memory_inspect.ts src/tools/index.ts test/tools/memory_inspect.test.ts && git commit -m 'feat(tools): add memory_inspect tool for memory overview'"
```

---

### Task 7: memory_edit 工具（写入指定记忆层）

> 让 Agent 能编辑非固定区与公共知识库。**固定区（AGENT.md）需要二次确认标记**，避免误改身份/约束。

**Files:**
- Create: `src/tools/memory_edit.ts`
- Modify: `src/tools/index.ts`
- Test: `test/tools/memory_edit.test.ts`

**Step 1: Write the failing test**

```typescript
// test/tools/memory_edit.test.ts
import { describe, it, expect, beforeEach } from "vitest"
import { mkdirSync, rmSync, readFileSync, existsSync } from "fs"
import { join } from "path"
import "../../src/tools/memory_edit.js"
import { registry } from "../../src/tools/registry.js"

const ROOT = "/tmp/gc-me-test"

describe("memory_edit tool", () => {
  beforeEach(() => {
    rmSync(ROOT, { recursive: true, force: true })
    mkdirSync(join(ROOT, "agents", "a1"), { recursive: true })
  })

  it("writes agent non-fixed memory (MEMORY.md)", async () => {
    const tool = registry.get("memory_edit")!
    const res = await tool.handler(
      { layer: "agent_nonfixed", mode: "replace", content: "NEW PRIVATE NOTE" },
      { sessionId: "s", workdir: ".", logger: console, extra: { memoryRoot: ROOT, targetAgentId: "a1" } } as any,
    )
    expect(res.type).toBe("text")
    const file = join(ROOT, "agents", "a1", "MEMORY.md")
    expect(existsSync(file)).toBe(true)
    expect(readFileSync(file, "utf-8")).toContain("NEW PRIVATE NOTE")
  })

  it("refuses to edit fixed layer without confirm flag", async () => {
    const tool = registry.get("memory_edit")!
    const res = await tool.handler(
      { layer: "agent_fixed", mode: "replace", content: "hack identity" },
      { sessionId: "s", workdir: ".", logger: console, extra: { memoryRoot: ROOT, targetAgentId: "a1" } } as any,
    )
    expect(res.type).toBe("error")
  })

  it("appends to agent non-fixed memory", async () => {
    const tool = registry.get("memory_edit")!
    await tool.handler({ layer: "agent_nonfixed", mode: "replace", content: "L1" },
      { sessionId: "s", workdir: ".", logger: console, extra: { memoryRoot: ROOT, targetAgentId: "a1" } } as any)
    await tool.handler({ layer: "agent_nonfixed", mode: "append", content: "L2" },
      { sessionId: "s", workdir: ".", logger: console, extra: { memoryRoot: ROOT, targetAgentId: "a1" } } as any)
    const file = join(ROOT, "agents", "a1", "MEMORY.md")
    const txt = readFileSync(file, "utf-8")
    expect(txt).toContain("L1")
    expect(txt).toContain("L2")
  })
})
```

**Step 2: Run test to verify it fails** → FAIL

**Step 3: Write minimal implementation**

```typescript
// @ts-nocheck
// src/tools/memory_edit.ts
import { registry } from "./registry.js"
import { MemoryPaths } from "../memory/paths.js"
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "fs"
import { dirname } from "path"

const FIXED_LAYERS = new Set(["global_fixed", "agent_fixed"])

function pathFor(layer: string, paths: MemoryPaths, agentId: string | undefined, date: string): string | null {
  switch (layer) {
    case "global_fixed": return paths.globalAgentMd()
    case "global_nonfixed": return paths.globalMemoryMd()
    case "global_daily": return paths.globalDaily(date)
    case "agent_fixed": return agentId ? paths.agentAgentMd(agentId) : null
    case "agent_nonfixed": return agentId ? paths.agentMemoryMd(agentId) : null
    case "agent_daily": return agentId ? paths.agentDaily(agentId, date) : null
    default: return null
  }
}

registry.register({
  name: "memory_edit",
  description: "编辑记忆层。layer: global_nonfixed/global_daily/agent_nonfixed/agent_daily（可压缩区，自由编辑）；global_fixed/agent_fixed（固定区，需 confirm=true 才允许，谨慎修改身份约束）。mode: replace 覆盖 / append 追加。仅在记忆管理会话中使用。",
  schema: {
    type: "object",
    properties: {
      layer: { type: "string", description: "目标记忆层" },
      mode: { type: "string", enum: ["replace", "append"], description: "写入方式" },
      content: { type: "string", description: "要写入的内容" },
      confirm: { type: "boolean", description: "修改固定区时必须为 true" },
    },
    required: ["layer", "mode", "content"],
  },
  handler: async (params, ctx) => {
    const root = ctx.extra?.memoryRoot as string | undefined
    const targetAgentId = ctx.extra?.targetAgentId as string | undefined
    const paths = new MemoryPaths(root)
    const date = new Date().toISOString().slice(0, 10)
    const layer = params.layer as string
    const mode = (params.mode as string) || "replace"
    const content = (params.content as string) ?? ""

    if (FIXED_LAYERS.has(layer) && params.confirm !== true) {
      return { type: "error", error: `修改固定区(${layer})会影响助手身份/约束，需传 confirm=true 二次确认。` }
    }

    const file = pathFor(layer, paths, targetAgentId, date)
    if (!file) return { type: "error", error: `未知或不可用的记忆层: ${layer}（agent 类层需要 targetAgentId）` }

    mkdirSync(dirname(file), { recursive: true })
    const final = mode === "append" && existsSync(file)
      ? readFileSync(file, "utf-8").trimEnd() + "\n\n" + content
      : content
    writeFileSync(file, final, "utf-8")
    ctx.logger.info(`[memory_edit] wrote ${layer} (${Buffer.byteLength(final)}B) → ${file}`)
    return { type: "text", text: `已${mode === "append" ? "追加到" : "更新"} ${layer}（${Buffer.byteLength(final)} 字节）。` }
  },
})
```

`src/tools/index.ts` 追加：`import './memory_edit.js';`

**Step 4: Run test to verify it passes** → PASS（3 tests）

**Step 5: Coverage** → memory_edit.ts 行覆盖 ≥ 60%

**Step 6: Commit**

```bash
ssh -p 6022 pingjiangli@49.232.173.252 "cd ~/Code/GeminiClaw && git add src/tools/memory_edit.ts src/tools/index.ts test/tools/memory_edit.test.ts && git commit -m 'feat(tools): add memory_edit tool with fixed-layer guard'"
```

---

## Stage 5：/mem 命令与记忆管家 Agent（隔离会话）

### Task 8: 数据迁移脚本（旧路径 → 新路径）

> 一次性把现有 `~/.gemeniclaw/.workspace/MEMORY.md` 与日记迁到全局新路径；每个现有 agent 建立 agent_memory 行（bootstrapped=0）。

**Files:**
- Create: `scripts/migrate-memory-layout.ts`
- Test: `test/scripts/migrate-memory-layout.test.ts`

**Step 1: Write the failing test**

```typescript
// test/scripts/migrate-memory-layout.test.ts
import { describe, it, expect, beforeEach } from "vitest"
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "fs"
import { join } from "path"
import { migrateMemoryLayout } from "../../scripts/migrate-memory-layout.js"

const ROOT = "/tmp/gc-mig-test"

describe("migrateMemoryLayout", () => {
  beforeEach(() => {
    rmSync(ROOT, { recursive: true, force: true })
    mkdirSync(join(ROOT, ".workspace", "memory"), { recursive: true })
    writeFileSync(join(ROOT, ".workspace", "MEMORY.md"), "OLD GLOBAL LTM")
    writeFileSync(join(ROOT, ".workspace", "memory", "2026-06-10.md"), "OLD DAILY")
  })

  it("moves old workspace MEMORY.md to new global path", () => {
    migrateMemoryLayout(ROOT)
    const newPath = join(ROOT, "memory", "global", "MEMORY.md")
    expect(existsSync(newPath)).toBe(true)
    expect(readFileSync(newPath, "utf-8")).toContain("OLD GLOBAL LTM")
  })

  it("moves old daily notes to new global daily dir", () => {
    migrateMemoryLayout(ROOT)
    expect(existsSync(join(ROOT, "memory", "global", "daily", "2026-06-10.md"))).toBe(true)
  })

  it("is idempotent (safe to run twice)", () => {
    migrateMemoryLayout(ROOT)
    expect(() => migrateMemoryLayout(ROOT)).not.toThrow()
  })
})
```

**Step 2: Run test to verify it fails** → FAIL

**Step 3: Write minimal implementation**

```typescript
// scripts/migrate-memory-layout.ts
import { mkdirSync, existsSync, readdirSync, copyFileSync } from "fs"
import { join } from "path"
import os from "os"

export function migrateMemoryLayout(root: string = join(os.homedir(), ".gemeniclaw")): void {
  const oldWs = join(root, ".workspace")
  const newGlobalDir = join(root, "memory", "global")
  const newDailyDir = join(newGlobalDir, "daily")
  mkdirSync(newDailyDir, { recursive: true })

  // 全局长期记忆
  const oldMem = join(oldWs, "MEMORY.md")
  const newMem = join(newGlobalDir, "MEMORY.md")
  if (existsSync(oldMem) && !existsSync(newMem)) copyFileSync(oldMem, newMem)

  // 全局日记
  const oldDailyDir = join(oldWs, "memory")
  if (existsSync(oldDailyDir)) {
    for (const f of readdirSync(oldDailyDir)) {
      if (!f.endsWith(".md")) continue
      const dst = join(newDailyDir, f)
      if (!existsSync(dst)) copyFileSync(join(oldDailyDir, f), dst)
    }
  }
}

// CLI entry
if (process.argv[1]?.endsWith("migrate-memory-layout.ts") || process.argv[1]?.endsWith("migrate-memory-layout.js")) {
  migrateMemoryLayout()
  console.log("memory layout migration done")
}
```

**Step 4: Run test to verify it passes** → PASS（3 tests）

**Step 5: Coverage** → ≥ 60%

**Step 6: Commit + 执行线上迁移（确认后）**

```bash
ssh -p 6022 pingjiangli@49.232.173.252 "cd ~/Code/GeminiClaw && git add scripts/migrate-memory-layout.ts test/scripts/ && git commit -m 'feat(scripts): migrate memory layout to layered paths'"
# 确认后执行线上迁移：
ssh -p 6022 pingjiangli@49.232.173.252 "cd ~/Code/GeminiClaw && npx tsx scripts/migrate-memory-layout.ts"
```
Expected: 旧 MEMORY.md 与日记复制到 `~/.gemeniclaw/memory/global/`（原文件保留作兜底）

---

### Task 9: MemoryManagerSession —— 隔离的记忆管家会话

> `/mem` 进入后，创建一个临时隔离 session（不写回原 agent 的 chat_messages），加载「记忆管家」专用 system prompt，只挂 memory_inspect / memory_edit / list_agents 工具。退出时清理临时 session。

**Files:**
- Create: `src/guidance/memory-manager.ts`
- Test: `test/guidance/memory-manager.test.ts`

**Step 1: Write the failing test**

```typescript
// test/guidance/memory-manager.test.ts
import { describe, it, expect, beforeEach } from "vitest"
import Database from "better-sqlite3"
import { migrate } from "../../src/db/schema.js"
import { MemoryManagerSession } from "../../src/guidance/memory-manager.js"

describe("MemoryManagerSession", () => {
  let db: any
  beforeEach(() => { db = new Database(":memory:"); migrate(db) })

  it("enter() creates an isolated session bound to the target agent", () => {
    const mm = new MemoryManagerSession(db)
    const s = mm.enter("user1", "agent-a1", "龙股助手")
    expect(s.sessionId).toMatch(/^mem-/)        // 临时隔离 session 前缀
    expect(s.targetAgentId).toBe("agent-a1")
    expect(mm.isActive("user1")).toBe(true)
  })

  it("exit() ends the management session", () => {
    const mm = new MemoryManagerSession(db)
    mm.enter("user1", "agent-a1", "龙股助手")
    mm.exit("user1")
    expect(mm.isActive("user1")).toBe(false)
  })

  it("getActive() returns target agent + isolated session for active user", () => {
    const mm = new MemoryManagerSession(db)
    mm.enter("user1", "agent-a1", "龙股助手")
    const a = mm.getActive("user1")!
    expect(a.targetAgentId).toBe("agent-a1")
  })
})
```

**Step 2: Run test to verify it fails** → FAIL

**Step 3: Write minimal implementation**

```typescript
// src/guidance/memory-manager.ts
import type { Db } from "../db/client.js"
import { randomUUID } from "crypto"

export interface MemSession {
  sessionId: string       // 隔离临时 session（mem-<uuid>）
  targetAgentId: string   // 被管理的 agent
  targetAgentName: string
}

export const MEMORY_MANAGER_PROMPT = `你是「记忆管家」，专门帮助用户查看和整理当前助手的记忆。
你可以用 memory_inspect 查看记忆全景，用 memory_edit 编辑各记忆层。
记忆分为：
- 全局固定区 / 私人固定区（不可压缩，谨慎修改，改动需 confirm）
- 全局非固定区 / 私人非固定区（可压缩，可自由整理）
- 公共知识库（跨助手共享）
请先用 memory_inspect 了解现状，再根据用户意图精准编辑。每次编辑后复述你做了什么。
注意：你在隔离会话中工作，这里的对话不会进入原助手的记忆。`

export class MemoryManagerSession {
  private active = new Map<string, MemSession>() // userId -> session
  constructor(private db: Db) {}

  enter(userId: string, targetAgentId: string, targetAgentName: string): MemSession {
    const s: MemSession = {
      sessionId: `mem-${randomUUID().slice(0, 12)}`,
      targetAgentId,
      targetAgentName,
    }
    this.active.set(userId, s)
    return s
  }

  exit(userId: string): void {
    const s = this.active.get(userId)
    if (s) {
      // 清理隔离 session 的临时消息（若曾落盘）
      try { this.db.prepare(`DELETE FROM chat_messages WHERE session_id = ?`).run(s.sessionId) } catch {}
      try { this.db.prepare(`DELETE FROM chat_sessions WHERE id = ?`).run(s.sessionId) } catch {}
    }
    this.active.delete(userId)
  }

  isActive(userId: string): boolean { return this.active.has(userId) }
  getActive(userId: string): MemSession | null { return this.active.get(userId) ?? null }
}
```

**Step 4: Run test to verify it passes** → PASS（3 tests）

**Step 5: Coverage** → ≥ 60%

**Step 6: Commit**

```bash
ssh -p 6022 pingjiangli@49.232.173.252 "cd ~/Code/GeminiClaw && git add src/guidance/memory-manager.ts test/guidance/ && git commit -m 'feat(guidance): add isolated MemoryManagerSession'"
```

---

### Task 10: /mem 命令 + 自然语言触发，接入 QQBot 消息流

> 在 `qqbot/index.ts:handleMessage` 中：检测 `/mem`（命令）或「整理/梳理 记忆」「记忆管理」（自然语言）→ 进入记忆管家会话；活跃期间所有消息路由到记忆管家（用隔离 session + memory_inspect/memory_edit 工具 + targetAgentId）；`/exit`（或「退出记忆管理」）退出。

**Files:**
- Modify: `src/commands/registry.ts`（注册 `mem` 命令）
- Modify: `src/channels/qqbot/index.ts`（拦截 + 路由 + toolContextExtra 注入 targetAgentId/memoryRoot）
- Test: `test/channels/mem-routing.test.ts`（对 handleMessage 拆出的可测函数做单测）

**Step 1: Write the failing test**

> 把「是否进入/退出记忆管理 + 解析目标 agent」逻辑抽到纯函数 `resolveMemIntent(text)`，便于单测。

```typescript
// test/channels/mem-routing.test.ts
import { describe, it, expect } from "vitest"
import { resolveMemIntent } from "../../src/guidance/mem-intent.js"

describe("resolveMemIntent", () => {
  it("detects /mem command", () => {
    expect(resolveMemIntent("/mem")?.action).toBe("enter")
  })
  it("detects natural language enter", () => {
    expect(resolveMemIntent("帮我整理一下当前助手的记忆")?.action).toBe("enter")
    expect(resolveMemIntent("梳理工作记忆")?.action).toBe("enter")
  })
  it("detects exit", () => {
    expect(resolveMemIntent("/exit")?.action).toBe("exit")
    expect(resolveMemIntent("退出记忆管理")?.action).toBe("exit")
  })
  it("returns null for normal chat", () => {
    expect(resolveMemIntent("今天龙股有什么信号")).toBeNull()
  })
})
```

**Step 2: Run test to verify it fails** → FAIL

**Step 3: Write minimal implementation**

```typescript
// src/guidance/mem-intent.ts
export interface MemIntent { action: "enter" | "exit" }

const ENTER_RE = /(整理|梳理).*(记忆|工作记忆)|记忆管理|管理.*记忆/
const EXIT_RE = /退出.*记忆|结束.*记忆管理/

export function resolveMemIntent(text: string): MemIntent | null {
  const t = text.trim()
  if (t === "/mem" || t.startsWith("/mem ")) return { action: "enter" }
  if (t === "/exit" || EXIT_RE.test(t)) return { action: "exit" }
  if (ENTER_RE.test(t)) return { action: "enter" }
  return null
}
```

在 `qqbot/index.ts` 顶层实例化 `const memMgr = new MemoryManagerSession(this.db!)`，并在 `handleMessage` 命令拦截之后、AgentGate 之前插入：

```typescript
// ── 记忆管理拦截 ──
const memIntent = resolveMemIntent(content)
if (memMgr.isActive(userId) || memIntent) {
  if (memIntent?.action === "exit") {
    memMgr.exit(userId)
    return "已退出记忆管理，回到正常对话。"
  }
  if (memIntent?.action === "enter" && !memMgr.isActive(userId)) {
    // 目标 = 用户当前 sticky agent
    const sticky = this.db!.prepare(`SELECT agent_id, agent_name FROM user_sessions WHERE openid = ?`).get(userId) as any
    if (!sticky) return "你当前还没有活跃助手，先聊两句创建一个再来整理记忆。"
    const s = memMgr.enter(userId, sticky.agent_id, sticky.agent_name)
    // 首条进入：让记忆管家先 inspect
    return await runMemoryManager(s, `请先查看 ${sticky.agent_name} 的记忆全景，并简要汇报各层现状。`, userId)
  }
  // 已在记忆管理中 → 路由到记忆管家
  const s = memMgr.getActive(userId)!
  return await runMemoryManager(s, content, userId)
}
```

`runMemoryManager` 复用 agentLoop，但：
- `messages = [{role:"system", content: MEMORY_MANAGER_PROMPT}, {role:"user", content}]`
- `toolContextExtra: { db: this.db, userId, memoryRoot: <~/.gemeniclaw>, targetAgentId: s.targetAgentId }`
- 不调用 `memory.appendTurn`（隔离，不污染原 agent 历史）
- 用 `s.sessionId` 作为 agentLoop 的 sessionId

`src/commands/registry.ts` 增加：
```typescript
{ name: "mem", description: "进入记忆管理（整理当前助手记忆）", category: "session" },
```
（注意：dispatcher.ts 不处理 mem —— 让它返回 null 落到 handleMessage 的 memIntent 拦截；或在 dispatcher 直接返回特殊标记。最简方案：不在 dispatcher 注册 mem 的 case，仅在 registry 列出用于 /help 展示，实际拦截在 handleMessage。）

**Step 4: Run test to verify it passes** → PASS（4 tests）

**Step 5: Full build + tests**

Run: `ssh -p 6022 pingjiangli@49.232.173.252 "cd ~/Code/GeminiClaw && pnpm build 2>&1 | tail -3 && pnpm test 2>&1 | tail -10"`
Expected: build ok，测试不低于基线

**Step 6: Commit**

```bash
ssh -p 6022 pingjiangli@49.232.173.252 "cd ~/Code/GeminiClaw && git add src/guidance/mem-intent.ts src/commands/registry.ts src/channels/qqbot/index.ts test/channels/ && git commit -m 'feat(mem): /mem command + natural-language trigger routing to memory manager'"
```

---

## Stage 6：端到端验证

### Task 11: 端到端冒烟 + 线上验证

**Files:** 无（验证）

**Step 1: 全量构建 + 测试**

Run: `ssh -p 6022 pingjiangli@49.232.173.252 "cd ~/Code/GeminiClaw && pnpm build 2>&1 | tail -3 && pnpm test 2>&1 | tail -15"`
Expected: build 无错，测试全绿且不低于基线

**Step 2: 重启服务**

Run（按现有部署方式重启，确认进程起来、端口监听）：
```bash
ssh -p 6022 pingjiangli@49.232.173.252 "cd ~/Code/GeminiClaw && <restart command> && sleep 3 && curl -s localhost:<port>/v1/health"
```
Expected: health ok

**Step 3: 真机 QQ 验证（人工，逐项勾选）**

- 发 `/mem` → 收到记忆管家的「全景汇报」，列出五个区现状
- 发「把私人记忆里过期的 XX 删掉」→ memory_edit 生效，复述改动
- 发 `/exit` → 回到正常对话，且原助手历史里**没有**记忆管理对话
- 切到另一个 agent 再 `/mem` → 看到的是**那个 agent** 的私人记忆（隔离正确）
- 验证普通对话仍能注入私人记忆（私人 MEMORY.md 内容能被引用）

**Step 4: 数据核对**

Run:
```bash
ssh -p 6022 pingjiangli@49.232.173.252 "sqlite3 /Users/pingjiangli/.gemeniclaw/memory/geminiclaw.db 'SELECT count(*) FROM public_knowledge; SELECT count(*) FROM agent_memory;' && ls -R /Users/pingjiangli/.gemeniclaw/memory/global /Users/pingjiangli/.gemeniclaw/agents 2>/dev/null | head -30"
```
Expected: public_knowledge 数据完整（4 条），全局/agent 目录结构按新布局生成

**Step 5: 更新 CLAUDE.md / 记忆**

把新记忆架构写进 `~/.gemeniclaw/memory/global/MEMORY.md` 的「系统架构关键点」，并更新仓库 `CLAUDE.md` 的记忆说明段落。

**Step 6: Commit**

```bash
ssh -p 6022 pingjiangli@49.232.173.252 "cd ~/Code/GeminiClaw && git add CLAUDE.md docs/ && git commit -m 'docs: document layered memory architecture and /mem feature'"
```

---

## 风险与回滚

| 风险 | 缓解 |
|------|------|
| memory_topics 改名破坏读路径 | 保留兼容 view；改名前已备份 DB |
| 记忆管家误改固定区 | 固定区写入需 confirm=true；改前自动备份该文件 |
| 隔离 session 污染原历史 | runMemoryManager 不调用 appendTurn；exit 时清理临时 session |
| 自然语言误触发 /mem | 触发正则收紧，仅匹配「整理/梳理+记忆」「记忆管理」；可随时 /exit |
| 旧路径迁移丢数据 | 迁移用 copy 不 move，原文件保留；脚本幂等 |

**整体回滚：** `git revert` 相关 commit + 恢复 DB 备份 `geminiclaw.db.bak-*` + 删除新建目录 `~/.gemeniclaw/memory/global`、`~/.gemeniclaw/agents`。

---

## Execution Handoff

Plan complete. 实施时使用 super-assistant:subagent-driven-development，每个 Task 一个 fresh subagent + code review，逐任务确认（confirm_after_each_task: true）。所有命令通过 SSH 在远程 `pingjiangli@49.232.173.252:~/Code/GeminiClaw` 执行。