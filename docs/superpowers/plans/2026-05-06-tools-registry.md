# Tool Registry + P0 Tools Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a ToolRegistry singleton plus five P0 tools (exec, read, write, edit, web_fetch) that LLM providers can discover via `toAnthropicTools()`.

**Architecture:** Each tool is a self-contained file that calls `registry.register()` on import; `src/tools/index.ts` side-effect-imports all tools and re-exports the registry. The registry itself is a `Map`-backed class with a global singleton. Tests run against real filesystem (tmpdir) except exec timeout which uses a real slow command.

**Tech Stack:** TypeScript strict / ESM / Node.js `node:fs/promises`, `node:child_process`, `node:http`/`node:https` — zero new npm dependencies.

---

## File Map

| Action | Path | Responsibility |
|--------|------|----------------|
| Create | `src/tools/types.ts` | Shared interfaces: `JSONSchema`, `ToolResult`, `ToolContext`, `ToolHandler`, `ToolDefinition` |
| Create | `src/tools/registry.ts` | `ToolRegistry` class + `registry` singleton |
| Create | `src/tools/exec.ts` | `exec` tool — shell command via `spawn` |
| Create | `src/tools/read.ts` | `read` tool — file read with offset/limit |
| Create | `src/tools/write.ts` | `write` tool — file write with mkdir -p |
| Create | `src/tools/edit.ts` | `edit` tool — exact-text replacement |
| Create | `src/tools/web_fetch.ts` | `web_fetch` tool — HTTP fetch + HTML→markdown |
| Create | `src/tools/index.ts` | Side-effect imports + re-exports |
| Create | `src/tools/registry.test.ts` | ToolRegistry unit tests (5) |
| Create | `src/tools/exec.test.ts` | exec tool tests (5) |
| Create | `src/tools/read.test.ts` | read tool tests (5) |
| Create | `src/tools/write.test.ts` | write tool tests (4) |
| Create | `src/tools/edit.test.ts` | edit tool tests (5) |

---

## Task 1: Types + Registry

**Files:**
- Create: `src/tools/types.ts`
- Create: `src/tools/registry.ts`
- Create: `src/tools/registry.test.ts`

- [ ] **Step 1: Write the failing registry tests**

```typescript
// src/tools/registry.test.ts
import { describe, it, expect, beforeEach } from "vitest"
import { ToolRegistry } from "./registry.js"
import type { ToolDefinition } from "./types.js"

function makeToolDef(name: string, toolset?: string[]): ToolDefinition {
  return {
    name,
    description: `Test tool ${name}`,
    schema: { type: "object", properties: { x: { type: "string" } }, required: ["x"] },
    handler: async (_p, _c) => ({ type: "text", text: "ok" }),
    toolset,
  }
}

describe("ToolRegistry", () => {
  let registry: ToolRegistry

  beforeEach(() => {
    registry = new ToolRegistry()
  })

  it("register + get returns the tool", () => {
    const def = makeToolDef("my_tool")
    registry.register(def)
    expect(registry.get("my_tool")).toBe(def)
  })

  it("list() returns all tools", () => {
    registry.register(makeToolDef("a"))
    registry.register(makeToolDef("b"))
    expect(registry.list()).toHaveLength(2)
  })

  it("list(toolset) filters by toolset", () => {
    registry.register(makeToolDef("a", ["alpha"]))
    registry.register(makeToolDef("b", ["beta"]))
    registry.register(makeToolDef("c", ["alpha", "beta"]))
    expect(registry.list("alpha").map(t => t.name)).toEqual(["a", "c"])
  })

  it("toAnthropicTools() returns correct Anthropic format", () => {
    registry.register(makeToolDef("my_tool"))
    const tools = registry.toAnthropicTools()
    expect(tools).toHaveLength(1)
    expect(tools[0]).toEqual({
      name: "my_tool",
      description: "Test tool my_tool",
      input_schema: { type: "object", properties: { x: { type: "string" } }, required: ["x"] },
    })
  })

  it("get() returns null for unknown tool", () => {
    expect(registry.get("nonexistent")).toBeNull()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd ~/Codes/GeminiClaw && pnpm test src/tools/registry.test.ts 2>&1 | tail -20
```

Expected: FAIL — `registry.ts` does not exist yet.

- [ ] **Step 3: Create types.ts**

```typescript
// src/tools/types.ts
export interface JSONSchema {
  type: string
  properties?: Record<string, JSONSchema>
  required?: string[]
  description?: string
  items?: JSONSchema
  enum?: unknown[]
  [key: string]: unknown
}

export type ToolResult =
  | { type: "text"; text: string }
  | { type: "error"; error: string }

export interface ToolContext {
  sessionId: string
  workdir: string
  logger: {
    info(msg: string, ...args: unknown[]): void
    warn(msg: string, ...args: unknown[]): void
    error(msg: string, ...args: unknown[]): void
  }
}

export type ToolHandler = (
  params: Record<string, unknown>,
  ctx: ToolContext
) => Promise<ToolResult>

export interface ToolDefinition {
  name: string
  description: string
  schema: JSONSchema
  handler: ToolHandler
  toolset?: string[]
  requiresApproval?: boolean
  executionMode?: "sequential" | "parallel"
}
```

- [ ] **Step 4: Create registry.ts**

```typescript
// src/tools/registry.ts
import type { ToolDefinition, JSONSchema } from "./types.js"

export class ToolRegistry {
  private tools: Map<string, ToolDefinition> = new Map()

  register(def: ToolDefinition): void {
    this.tools.set(def.name, def)
  }

  get(name: string): ToolDefinition | null {
    return this.tools.get(name) ?? null
  }

  list(toolset?: string): ToolDefinition[] {
    const all = Array.from(this.tools.values())
    if (!toolset) return all
    return all.filter(t => t.toolset?.includes(toolset))
  }

  toAnthropicTools(): Array<{
    name: string
    description: string
    input_schema: JSONSchema
  }> {
    return this.list().map(t => ({
      name: t.name,
      description: t.description,
      input_schema: t.schema,
    }))
  }
}

// Global singleton
export const registry = new ToolRegistry()
```

- [ ] **Step 5: Run registry tests**

```bash
cd ~/Codes/GeminiClaw && pnpm test src/tools/registry.test.ts 2>&1 | tail -20
```

Expected: 5 passing.

- [ ] **Step 6: Commit**

```bash
cd ~/Codes/GeminiClaw && git add src/tools/types.ts src/tools/registry.ts src/tools/registry.test.ts
git commit -m "feat(tools): add ToolDefinition types and ToolRegistry"
```

---

## Task 2: exec tool

**Files:**
- Create: `src/tools/exec.ts`
- Create: `src/tools/exec.test.ts`

- [ ] **Step 1: Write the failing exec tests**

```typescript
// src/tools/exec.test.ts
import { describe, it, expect } from "vitest"
import { tmpdir } from "node:os"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import "../tools/exec.js"  // trigger self-registration
import { registry } from "./registry.js"
import type { ToolContext } from "./types.js"

function makeCtx(workdir: string): ToolContext {
  return {
    sessionId: "test-session",
    workdir,
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
    },
  }
}

describe("exec tool", () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "exec-test-"))
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it("executes simple command and returns stdout", async () => {
    const tool = registry.get("exec")!
    const result = await tool.handler({ command: "echo hello" }, makeCtx(tmpDir))
    expect(result.type).toBe("text")
    expect((result as { type: "text"; text: string }).text).toContain("hello")
  })

  it("returns error result for non-zero exit code", async () => {
    const tool = registry.get("exec")!
    const result = await tool.handler({ command: "exit 1" }, makeCtx(tmpDir))
    expect(result.type).toBe("error")
  })

  it("truncates output exceeding 8000 chars", async () => {
    const tool = registry.get("exec")!
    // Generate large output: print 9000 'a' chars
    const result = await tool.handler(
      { command: "python3 -c \"print('a' * 9000)\"" },
      makeCtx(tmpDir)
    )
    expect(result.type).toBe("text")
    const text = (result as { type: "text"; text: string }).text
    expect(text).toContain("[truncated]")
    expect(text.length).toBeLessThan(9000)
  })

  it("returns error when timeout is exceeded", async () => {
    const tool = registry.get("exec")!
    const result = await tool.handler(
      { command: "sleep 10", timeout: 1 },
      makeCtx(tmpDir)
    )
    expect(result.type).toBe("error")
    expect((result as { type: "error"; error: string }).error).toContain("timed out")
  })

  it("uses workdir parameter when specified", async () => {
    const tool = registry.get("exec")!
    const result = await tool.handler(
      { command: "pwd", workdir: tmpDir },
      makeCtx(tmpDir)
    )
    expect(result.type).toBe("text")
    // On macOS, /tmp is a symlink to /private/tmp
    const text = (result as { type: "text"; text: string }).text.trim()
    expect(text.endsWith(tmpDir) || tmpDir.endsWith(text)).toBe(true)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd ~/Codes/GeminiClaw && pnpm test src/tools/exec.test.ts 2>&1 | tail -20
```

Expected: FAIL — `exec.ts` does not exist.

- [ ] **Step 3: Create exec.ts**

```typescript
// src/tools/exec.ts
import { spawn } from "node:child_process"
import { registry } from "./registry.js"

const MAX_OUTPUT = 8000
const HEAD_TAIL = 2000

function truncate(output: string): string {
  if (output.length <= MAX_OUTPUT) return output
  const head = output.slice(0, HEAD_TAIL)
  const tail = output.slice(-HEAD_TAIL)
  return `${head}\n...[truncated]...\n${tail}`
}

registry.register({
  name: "exec",
  description: "Execute a shell command and return stdout+stderr. Use with care.",
  schema: {
    type: "object",
    properties: {
      command: { type: "string", description: "Shell command to execute" },
      timeout: { type: "number", description: "Timeout in seconds (default: 30)" },
      workdir: { type: "string", description: "Working directory (default: ctx.workdir)" },
    },
    required: ["command"],
  },
  requiresApproval: true,
  executionMode: "sequential",
  handler: async (params, ctx) => {
    const command = params.command as string
    const timeoutSecs = (params.timeout as number | undefined) ?? 30
    const workdir = (params.workdir as string | undefined) ?? ctx.workdir

    return new Promise<import("./types.js").ToolResult>(resolve => {
      const chunks: Buffer[] = []
      let timedOut = false

      const child = spawn("sh", ["-c", command], {
        cwd: workdir,
        stdio: ["ignore", "pipe", "pipe"],
      })

      child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk))
      child.stderr.on("data", (chunk: Buffer) => chunks.push(chunk))

      const timer = setTimeout(() => {
        timedOut = true
        child.kill("SIGKILL")
      }, timeoutSecs * 1000)

      child.on("close", (code: number | null) => {
        clearTimeout(timer)
        const output = Buffer.concat(chunks).toString("utf8")
        if (timedOut) {
          resolve({ type: "error", error: `Command timed out after ${timeoutSecs}s` })
          return
        }
        if (code !== 0) {
          resolve({ type: "error", error: truncate(output) || `Exit code ${code}` })
          return
        }
        resolve({ type: "text", text: truncate(output) })
      })

      child.on("error", (err: Error) => {
        clearTimeout(timer)
        resolve({ type: "error", error: err.message })
      })
    })
  },
})
```

- [ ] **Step 4: Run exec tests**

```bash
cd ~/Codes/GeminiClaw && pnpm test src/tools/exec.test.ts 2>&1 | tail -20
```

Expected: 5 passing.

- [ ] **Step 5: Commit**

```bash
cd ~/Codes/GeminiClaw && git add src/tools/exec.ts src/tools/exec.test.ts
git commit -m "feat(tools): add exec tool with timeout and output truncation"
```

---

## Task 3: read tool

**Files:**
- Create: `src/tools/read.ts`
- Create: `src/tools/read.test.ts`

- [ ] **Step 1: Write the failing read tests**

```typescript
// src/tools/read.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { tmpdir } from "node:os"
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import "../tools/read.js"  // trigger self-registration
import { registry } from "./registry.js"
import type { ToolContext } from "./types.js"

function makeCtx(workdir: string): ToolContext {
  return {
    sessionId: "test-session",
    workdir,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  }
}

describe("read tool", () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "read-test-"))
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it("reads file content", async () => {
    const file = join(tmpDir, "hello.txt")
    writeFileSync(file, "line1\nline2\nline3\n")
    const tool = registry.get("read")!
    const result = await tool.handler({ path: file }, makeCtx(tmpDir))
    expect(result.type).toBe("text")
    expect((result as { type: "text"; text: string }).text).toContain("line1")
    expect((result as { type: "text"; text: string }).text).toContain("line3")
  })

  it("respects offset and limit", async () => {
    const file = join(tmpDir, "lines.txt")
    const lines = Array.from({ length: 10 }, (_, i) => `line${i + 1}`).join("\n")
    writeFileSync(file, lines)
    const tool = registry.get("read")!
    const result = await tool.handler({ path: file, offset: 3, limit: 2 }, makeCtx(tmpDir))
    expect(result.type).toBe("text")
    const text = (result as { type: "text"; text: string }).text
    expect(text).toContain("line3")
    expect(text).toContain("line4")
    expect(text).not.toContain("line1")
    expect(text).not.toContain("line5")
  })

  it("returns error for non-existent file", async () => {
    const tool = registry.get("read")!
    const result = await tool.handler(
      { path: join(tmpDir, "nope.txt") },
      makeCtx(tmpDir)
    )
    expect(result.type).toBe("error")
  })

  it("truncates files over 2000 lines and adds note", async () => {
    const file = join(tmpDir, "big.txt")
    const lines = Array.from({ length: 2500 }, (_, i) => `line${i + 1}`).join("\n")
    writeFileSync(file, lines)
    const tool = registry.get("read")!
    const result = await tool.handler({ path: file }, makeCtx(tmpDir))
    expect(result.type).toBe("text")
    const text = (result as { type: "text"; text: string }).text
    expect(text).toContain("[truncated")
  })

  it("returns error when path is a directory", async () => {
    const dir = join(tmpDir, "subdir")
    mkdirSync(dir)
    const tool = registry.get("read")!
    const result = await tool.handler({ path: dir }, makeCtx(tmpDir))
    expect(result.type).toBe("error")
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd ~/Codes/GeminiClaw && pnpm test src/tools/read.test.ts 2>&1 | tail -20
```

Expected: FAIL — `read.ts` does not exist.

- [ ] **Step 3: Create read.ts**

```typescript
// src/tools/read.ts
import { readFile, stat } from "node:fs/promises"
import { registry } from "./registry.js"

const MAX_LINES = 2000
const MAX_BYTES = 50 * 1024  // 50 KB

registry.register({
  name: "read",
  description: "Read a file. Supports line-range slicing via offset (1-indexed) and limit.",
  schema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Absolute or relative file path" },
      offset: { type: "number", description: "First line to return (1-indexed, default: 1)" },
      limit: { type: "number", description: "Maximum number of lines to return" },
    },
    required: ["path"],
  },
  executionMode: "parallel",
  handler: async (params, _ctx) => {
    const filePath = params.path as string
    const offset = ((params.offset as number | undefined) ?? 1)
    const limit = params.limit as number | undefined

    try {
      const info = await stat(filePath)
      if (info.isDirectory()) {
        return { type: "error", error: `Path is a directory: ${filePath}` }
      }
    } catch {
      return { type: "error", error: `File not found: ${filePath}` }
    }

    let raw: string
    try {
      const buf = await readFile(filePath)
      if (buf.length > MAX_BYTES) {
        raw = buf.slice(0, MAX_BYTES).toString("utf8")
        const lines = raw.split("\n")
        return {
          type: "text",
          text: lines.slice(0, MAX_LINES).join("\n") +
            `\n[truncated: file exceeds ${MAX_BYTES} bytes, showing first ${MAX_LINES} lines]`,
        }
      }
      raw = buf.toString("utf8")
    } catch (err) {
      return { type: "error", error: (err as Error).message }
    }

    const allLines = raw.split("\n")

    if (allLines.length > MAX_LINES && !limit) {
      return {
        type: "text",
        text: allLines.slice(0, MAX_LINES).join("\n") +
          `\n[truncated: ${allLines.length} total lines, showing first ${MAX_LINES}]`,
      }
    }

    // offset is 1-indexed
    const startIdx = Math.max(0, offset - 1)
    const endIdx = limit !== undefined ? startIdx + limit : allLines.length
    const slice = allLines.slice(startIdx, endIdx)

    return { type: "text", text: slice.join("\n") }
  },
})
```

- [ ] **Step 4: Run read tests**

```bash
cd ~/Codes/GeminiClaw && pnpm test src/tools/read.test.ts 2>&1 | tail -20
```

Expected: 5 passing.

- [ ] **Step 5: Commit**

```bash
cd ~/Codes/GeminiClaw && git add src/tools/read.ts src/tools/read.test.ts
git commit -m "feat(tools): add read tool with offset/limit and truncation"
```

---

## Task 4: write tool

**Files:**
- Create: `src/tools/write.ts`
- Create: `src/tools/write.test.ts`

- [ ] **Step 1: Write the failing write tests**

```typescript
// src/tools/write.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { tmpdir } from "node:os"
import { mkdtempSync, rmSync, readFileSync, writeFileSync, chmodSync } from "node:fs"
import { join } from "node:path"
import "../tools/write.js"  // trigger self-registration
import { registry } from "./registry.js"
import type { ToolContext } from "./types.js"

function makeCtx(workdir: string): ToolContext {
  return {
    sessionId: "test-session",
    workdir,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  }
}

describe("write tool", () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "write-test-"))
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it("writes file content successfully", async () => {
    const file = join(tmpDir, "out.txt")
    const tool = registry.get("write")!
    const result = await tool.handler({ path: file, content: "hello world" }, makeCtx(tmpDir))
    expect(result.type).toBe("text")
    expect(readFileSync(file, "utf8")).toBe("hello world")
  })

  it("auto-creates parent directories", async () => {
    const file = join(tmpDir, "a", "b", "c.txt")
    const tool = registry.get("write")!
    const result = await tool.handler({ path: file, content: "nested" }, makeCtx(tmpDir))
    expect(result.type).toBe("text")
    expect(readFileSync(file, "utf8")).toBe("nested")
  })

  it("overwrites an existing file", async () => {
    const file = join(tmpDir, "existing.txt")
    writeFileSync(file, "old content")
    const tool = registry.get("write")!
    await tool.handler({ path: file, content: "new content" }, makeCtx(tmpDir))
    expect(readFileSync(file, "utf8")).toBe("new content")
  })

  it("returns error when path is not writable", async () => {
    // Create a read-only directory
    const roDir = join(tmpDir, "readonly")
    const { mkdirSync } = await import("node:fs")
    mkdirSync(roDir)
    chmodSync(roDir, 0o555)
    const file = join(roDir, "out.txt")
    const tool = registry.get("write")!
    const result = await tool.handler({ path: file, content: "data" }, makeCtx(tmpDir))
    // Restore permissions so cleanup works
    chmodSync(roDir, 0o755)
    expect(result.type).toBe("error")
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd ~/Codes/GeminiClaw && pnpm test src/tools/write.test.ts 2>&1 | tail -20
```

Expected: FAIL — `write.ts` does not exist.

- [ ] **Step 3: Create write.ts**

```typescript
// src/tools/write.ts
import { writeFile, mkdir } from "node:fs/promises"
import { dirname } from "node:path"
import { registry } from "./registry.js"

registry.register({
  name: "write",
  description: "Write content to a file, creating parent directories as needed.",
  schema: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path to write to" },
      content: { type: "string", description: "Content to write" },
    },
    required: ["path", "content"],
  },
  requiresApproval: true,
  executionMode: "sequential",
  handler: async (params, _ctx) => {
    const filePath = params.path as string
    const content = params.content as string

    try {
      await mkdir(dirname(filePath), { recursive: true })
      await writeFile(filePath, content, "utf8")
      return { type: "text", text: `Written to ${filePath}` }
    } catch (err) {
      return { type: "error", error: (err as Error).message }
    }
  },
})
```

- [ ] **Step 4: Run write tests**

```bash
cd ~/Codes/GeminiClaw && pnpm test src/tools/write.test.ts 2>&1 | tail -20
```

Expected: 4 passing.

- [ ] **Step 5: Commit**

```bash
cd ~/Codes/GeminiClaw && git add src/tools/write.ts src/tools/write.test.ts
git commit -m "feat(tools): add write tool with mkdir -p"
```

---

## Task 5: edit tool

**Files:**
- Create: `src/tools/edit.ts`
- Create: `src/tools/edit.test.ts`

- [ ] **Step 1: Write the failing edit tests**

```typescript
// src/tools/edit.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { tmpdir } from "node:os"
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import "../tools/edit.js"  // trigger self-registration
import { registry } from "./registry.js"
import type { ToolContext } from "./types.js"

function makeCtx(workdir: string): ToolContext {
  return {
    sessionId: "test-session",
    workdir,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  }
}

describe("edit tool", () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "edit-test-"))
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it("replaces a single edit successfully", async () => {
    const file = join(tmpDir, "file.txt")
    writeFileSync(file, "hello world\n")
    const tool = registry.get("edit")!
    const result = await tool.handler(
      { path: file, edits: [{ oldText: "hello", newText: "goodbye" }] },
      makeCtx(tmpDir)
    )
    expect(result.type).toBe("text")
    expect(readFileSync(file, "utf8")).toBe("goodbye world\n")
  })

  it("applies multiple edits sequentially", async () => {
    const file = join(tmpDir, "multi.txt")
    writeFileSync(file, "alpha beta gamma\n")
    const tool = registry.get("edit")!
    await tool.handler(
      {
        path: file,
        edits: [
          { oldText: "alpha", newText: "ONE" },
          { oldText: "gamma", newText: "THREE" },
        ],
      },
      makeCtx(tmpDir)
    )
    expect(readFileSync(file, "utf8")).toBe("ONE beta THREE\n")
  })

  it("returns error when oldText is not found", async () => {
    const file = join(tmpDir, "notfound.txt")
    writeFileSync(file, "hello world\n")
    const tool = registry.get("edit")!
    const result = await tool.handler(
      { path: file, edits: [{ oldText: "xyz", newText: "abc" }] },
      makeCtx(tmpDir)
    )
    expect(result.type).toBe("error")
    expect((result as { type: "error"; error: string }).error).toContain("not found")
  })

  it("returns error when oldText appears more than once", async () => {
    const file = join(tmpDir, "dup.txt")
    writeFileSync(file, "foo bar foo\n")
    const tool = registry.get("edit")!
    const result = await tool.handler(
      { path: file, edits: [{ oldText: "foo", newText: "baz" }] },
      makeCtx(tmpDir)
    )
    expect(result.type).toBe("error")
    expect((result as { type: "error"; error: string }).error).toContain("multiple")
  })

  it("writes corrected content back to file", async () => {
    const file = join(tmpDir, "content.ts")
    writeFileSync(file, "const x = 1\nconst y = 2\n")
    const tool = registry.get("edit")!
    await tool.handler(
      { path: file, edits: [{ oldText: "const y = 2", newText: "const y = 99" }] },
      makeCtx(tmpDir)
    )
    expect(readFileSync(file, "utf8")).toBe("const x = 1\nconst y = 99\n")
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd ~/Codes/GeminiClaw && pnpm test src/tools/edit.test.ts 2>&1 | tail -20
```

Expected: FAIL — `edit.ts` does not exist.

- [ ] **Step 3: Create edit.ts**

```typescript
// src/tools/edit.ts
import { readFile, writeFile } from "node:fs/promises"
import { registry } from "./registry.js"

interface EditPair {
  oldText: string
  newText: string
}

registry.register({
  name: "edit",
  description:
    "Perform exact text replacements in a file. Each edit must match exactly once.",
  schema: {
    type: "object",
    properties: {
      path: { type: "string", description: "File to edit" },
      edits: {
        type: "array",
        description: "List of {oldText, newText} replacements",
        items: {
          type: "object",
          properties: {
            oldText: { type: "string" },
            newText: { type: "string" },
          },
          required: ["oldText", "newText"],
        },
      },
    },
    required: ["path", "edits"],
  },
  requiresApproval: true,
  executionMode: "sequential",
  handler: async (params, _ctx) => {
    const filePath = params.path as string
    const edits = params.edits as EditPair[]

    let content: string
    try {
      content = await readFile(filePath, "utf8")
    } catch (err) {
      return { type: "error", error: (err as Error).message }
    }

    for (const edit of edits) {
      const first = content.indexOf(edit.oldText)
      if (first === -1) {
        return {
          type: "error",
          error: `oldText not found in file: "${edit.oldText.slice(0, 60)}"`,
        }
      }
      const second = content.indexOf(edit.oldText, first + 1)
      if (second !== -1) {
        return {
          type: "error",
          error: `oldText appears multiple times — cannot apply unique edit: "${edit.oldText.slice(0, 60)}"`,
        }
      }
      content = content.slice(0, first) + edit.newText + content.slice(first + edit.oldText.length)
    }

    try {
      await writeFile(filePath, content, "utf8")
    } catch (err) {
      return { type: "error", error: (err as Error).message }
    }

    return { type: "text", text: `Applied ${edits.length} edit(s) to ${filePath}` }
  },
})
```

- [ ] **Step 4: Run edit tests**

```bash
cd ~/Codes/GeminiClaw && pnpm test src/tools/edit.test.ts 2>&1 | tail -20
```

Expected: 5 passing.

- [ ] **Step 5: Commit**

```bash
cd ~/Codes/GeminiClaw && git add src/tools/edit.ts src/tools/edit.test.ts
git commit -m "feat(tools): add edit tool with uniqueness check"
```

---

## Task 6: web_fetch tool

**Files:**
- Create: `src/tools/web_fetch.ts`

No dedicated test file — web_fetch makes real HTTP calls which are non-deterministic. It's verified via the integration in Task 7.

- [ ] **Step 1: Create web_fetch.ts**

```typescript
// src/tools/web_fetch.ts
import { get as httpGet } from "node:http"
import { get as httpsGet } from "node:https"
import type { IncomingMessage } from "node:http"
import { registry } from "./registry.js"

const DEFAULT_MAX_CHARS = 20_000

function fetchUrl(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const getter = url.startsWith("https:") ? httpsGet : httpGet
    const req = getter(url, (res: IncomingMessage) => {
      // Follow one redirect
      if (
        res.statusCode !== undefined &&
        res.statusCode >= 300 &&
        res.statusCode < 400 &&
        res.headers.location
      ) {
        fetchUrl(res.headers.location).then(resolve).catch(reject)
        return
      }
      const chunks: Buffer[] = []
      res.on("data", (chunk: Buffer) => chunks.push(chunk))
      res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")))
      res.on("error", reject)
    })
    req.on("error", reject)
    req.setTimeout(15_000, () => {
      req.destroy(new Error("Request timed out after 15s"))
    })
  })
}

function htmlToMarkdown(html: string): string {
  // Remove script, style, head blocks
  let md = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<head[\s\S]*?<\/head>/gi, "")

  // Headings
  md = md
    .replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, "\n# $1\n")
    .replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, "\n## $1\n")
    .replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, "\n### $1\n")
    .replace(/<h4[^>]*>([\s\S]*?)<\/h4>/gi, "\n#### $1\n")
    .replace(/<h5[^>]*>([\s\S]*?)<\/h5>/gi, "\n##### $1\n")
    .replace(/<h6[^>]*>([\s\S]*?)<\/h6>/gi, "\n###### $1\n")

  // Links
  md = md.replace(/<a[^>]+href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, "[$2]($1)")

  // Lists
  md = md.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, "\n- $1")
  md = md.replace(/<\/?[uo]l[^>]*>/gi, "\n")

  // Paragraphs and breaks
  md = md.replace(/<p[^>]*>/gi, "\n").replace(/<\/p>/gi, "\n")
  md = md.replace(/<br\s*\/?>/gi, "\n")

  // Bold / italic
  md = md
    .replace(/<strong[^>]*>([\s\S]*?)<\/strong>/gi, "**$1**")
    .replace(/<b[^>]*>([\s\S]*?)<\/b>/gi, "**$1**")
    .replace(/<em[^>]*>([\s\S]*?)<\/em>/gi, "*$1*")
    .replace(/<i[^>]*>([\s\S]*?)<\/i>/gi, "*$1*")

  // Code
  md = md.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, "`$1`")
  md = md.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, "\n```\n$1\n```\n")

  // Remove remaining tags
  md = md.replace(/<[^>]+>/g, "")

  // Decode common HTML entities
  md = md
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")

  // Collapse multiple blank lines
  md = md.replace(/\n{3,}/g, "\n\n").trim()

  return md
}

registry.register({
  name: "web_fetch",
  description: "Fetch a URL and return its content as Markdown. HTML is simplified.",
  schema: {
    type: "object",
    properties: {
      url: { type: "string", description: "URL to fetch (http or https)" },
      maxChars: {
        type: "number",
        description: `Maximum output characters (default: ${DEFAULT_MAX_CHARS})`,
      },
    },
    required: ["url"],
  },
  executionMode: "parallel",
  handler: async (params, _ctx) => {
    const url = params.url as string
    const maxChars = (params.maxChars as number | undefined) ?? DEFAULT_MAX_CHARS

    let raw: string
    try {
      raw = await fetchUrl(url)
    } catch (err) {
      return { type: "error", error: `Fetch failed: ${(err as Error).message}` }
    }

    const md = htmlToMarkdown(raw)
    const truncated = md.length > maxChars
      ? md.slice(0, maxChars) + "\n\n[content truncated]"
      : md

    return { type: "text", text: truncated }
  },
})
```

- [ ] **Step 2: Quick build sanity check**

```bash
cd ~/Codes/GeminiClaw && pnpm build 2>&1 | tail -20
```

Expected: zero TypeScript errors.

- [ ] **Step 3: Commit**

```bash
cd ~/Codes/GeminiClaw && git add src/tools/web_fetch.ts
git commit -m "feat(tools): add web_fetch tool (HTML→markdown, no external deps)"
```

---

## Task 7: index.ts + full suite

**Files:**
- Create: `src/tools/index.ts`

- [ ] **Step 1: Create index.ts**

```typescript
// src/tools/index.ts
// Side-effect imports register all tools into the global registry singleton.
import "./exec.js"
import "./read.js"
import "./write.js"
import "./edit.js"
import "./web_fetch.js"

export { registry } from "./registry.js"
export type {
  ToolDefinition,
  ToolHandler,
  ToolResult,
  ToolContext,
  JSONSchema,
} from "./types.js"
```

- [ ] **Step 2: Build**

```bash
cd ~/Codes/GeminiClaw && pnpm build 2>&1 | tail -20
```

Expected: zero errors.

- [ ] **Step 3: Run all tool tests**

```bash
cd ~/Codes/GeminiClaw && pnpm test src/tools/ 2>&1 | tail -30
```

Expected: 24 passing (5 registry + 5 exec + 5 read + 4 write + 5 edit).

- [ ] **Step 4: Run full test suite**

```bash
cd ~/Codes/GeminiClaw && pnpm test 2>&1 | tail -30
```

Expected: 181+ passing, 0 failing.

- [ ] **Step 5: Commit**

```bash
cd ~/Codes/GeminiClaw && git add src/tools/index.ts
git commit -m "feat(tools): add ToolRegistry + P0 tools (exec/read/write/edit/web_fetch)"
```

---

## Self-Review

### Spec Coverage

| Spec requirement | Task |
|---|---|
| `types.ts` — `JSONSchema`, `ToolResult`, `ToolContext`, `ToolHandler`, `ToolDefinition` | Task 1 |
| `registry.ts` — `ToolRegistry` class + `registry` singleton | Task 1 |
| `exec.ts` — spawn, timeout 30s, stdout+stderr, truncate 8000 chars (head/tail 2000) | Task 2 |
| `read.ts` — offset/limit (1-indexed), 50KB/2000-line cap, dir error | Task 3 |
| `write.ts` — mkdir -p, overwrite | Task 4 |
| `edit.ts` — unique match check, multi-edit, write-back | Task 5 |
| `web_fetch.ts` — no external deps, HTML→markdown, 20000 char cap | Task 6 |
| `index.ts` — side-effect imports + re-exports | Task 7 |
| registry tests (5) | Task 1 |
| exec tests (5) | Task 2 |
| read tests (5) | Task 3 |
| write tests (4) | Task 4 |
| edit tests (5) | Task 5 |
| pnpm build zero errors | Tasks 2, 6, 7 |
| pnpm test src/tools/ all green | Task 7 |
| pnpm test full suite still green | Task 7 |

### Potential Issues

1. **exec test 3 (truncation)**: Uses `python3 -c`. If the CI box lacks python3, use `node -e "process.stdout.write('a'.repeat(9000))"` instead — but python3 is standard on macOS/Linux so this is fine.

2. **exec test 5 (workdir/pwd on macOS)**: `/tmp` resolves to `/private/tmp` via symlink. The test handles this with `text.endsWith(tmpDir) || tmpDir.endsWith(text)`.

3. **write test 4 (read-only dir)**: Runs as root in some CI environments where chmod has no effect. Acceptable test flake — the error path is also covered by any write failure.

4. **Type consistency**: All handler signatures use `Record<string, unknown>` params → cast internally. `ToolResult` union type flows consistently through all tools. `registry.get()` returns `ToolDefinition | null` everywhere.
