/**
 * Tests for MutatorImpl and its utility functions.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"
import {
  parseUnifiedDiff,
  applyFileDiff,
  extractDiff,
  extractConfidence,
  MutatorImpl,
  type FileSystem,
  type TypeChecker,
  type GitOps,
  type LlmClient,
  type MutatorConfig,
  type MutatorLogger,
  type FuzzyMatcher,
  type MutatorImplDeps,
} from "./mutator-impl.js"
import type { EvolutionIntent } from "./types.js"

// ── Test Helpers ─────────────────────────────────────────────────────────────

function makeIntent(overrides?: Partial<EvolutionIntent>): EvolutionIntent {
  return {
    id: "test-intent-001",
    type: "behavior_fix",
    description: "Fix the frobulator to handle null inputs",
    targetFiles: ["src/frobulator.ts"],
    evidence: ["Null pointer error in prod logs"],
    riskLevel: "low",
    requiresHumanApproval: false,
    createdAt: Date.now(),
    ...overrides,
  }
}

function makeDeps(overrides?: Partial<MutatorImplDeps>): MutatorImplDeps {
  const fileStore: Record<string, string> = {
    "/repo/src/frobulator.ts": 'export function frob(x: string) {\n  return x.trim()\n}\n',
  }

  const fs: FileSystem = {
    exists: (path) => path in fileStore,
    read: (path) => fileStore[path] ?? "",
    write: (path, content) => { fileStore[path] = content },
  }

  const typeChecker: TypeChecker = {
    check: () => ({ success: true, output: "" }),
  }

  const git: GitOps = {
    add: vi.fn(),
    commit: () => ({ success: true }),
  }

  const llm: LlmClient = {
    chat: vi.fn().mockResolvedValue(
      '```diff\n--- a/src/frobulator.ts\n+++ b/src/frobulator.ts\n@@ -1,3 +1,5 @@\n export function frob(x: string) {\n+  if (x == null) return ""\n   return x.trim()\n }\n```\n\n```json\n{"score": 0.9, "reason": "Simple null check", "uncertainties": []}\n```',
    ),
  }

  const config: MutatorConfig = {
    maxRounds: 3,
    confidenceThreshold: 0.7,
    repoRoot: "/repo",
  }

  const logger: MutatorLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }

  return { fs, typeChecker, git, llm, config, logger, ...overrides }
}

// ── parseUnifiedDiff tests ───────────────────────────────────────────────────

describe("parseUnifiedDiff", () => {
  it("parses a simple single-file diff", () => {
    const diff = `--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1,3 +1,4 @@
 line one
+inserted line
 line two
 line three
`
    const result = parseUnifiedDiff(diff)
    expect(result).toHaveLength(1)
    expect(result[0].oldPath).toBe("src/foo.ts")
    expect(result[0].newPath).toBe("src/foo.ts")
    expect(result[0].hunks).toHaveLength(1)
    expect(result[0].hunks[0].oldStart).toBe(1)
    expect(result[0].hunks[0].newStart).toBe(1)
    expect(result[0].hunks[0].lines).toContain("+inserted line")
  })

  it("parses multi-file diff", () => {
    const diff = `--- a/src/a.ts
+++ b/src/a.ts
@@ -1,2 +1,2 @@
-old a
+new a
 context
--- a/src/b.ts
+++ b/src/b.ts
@@ -5,3 +5,3 @@
 ctx
-old b
+new b
 ctx
`
    const result = parseUnifiedDiff(diff)
    expect(result).toHaveLength(2)
    expect(result[0].newPath).toBe("src/a.ts")
    expect(result[1].newPath).toBe("src/b.ts")
  })

  it("handles new file (/dev/null)", () => {
    const diff = `--- /dev/null
+++ b/src/new.ts
@@ -0,0 +1,2 @@
+export const x = 1
+export const y = 2
`
    const result = parseUnifiedDiff(diff)
    expect(result).toHaveLength(1)
    expect(result[0].oldPath).toBe("src/new.ts")
    expect(result[0].newPath).toBe("src/new.ts")
  })

  it("handles multiple hunks in one file", () => {
    const diff = `--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1,2 +1,2 @@
-line1
+LINE1
 context
@@ -10,2 +10,2 @@
-line10
+LINE10
 context
`
    const result = parseUnifiedDiff(diff)
    expect(result).toHaveLength(1)
    expect(result[0].hunks).toHaveLength(2)
    expect(result[0].hunks[0].oldStart).toBe(1)
    expect(result[0].hunks[1].oldStart).toBe(10)
  })

  it("returns empty array for non-diff text", () => {
    const result = parseUnifiedDiff("just some random text\nno diff here")
    expect(result).toHaveLength(0)
  })
})

// ── applyFileDiff tests ──────────────────────────────────────────────────────

describe("applyFileDiff", () => {
  it("applies a simple insertion", () => {
    const original = "line one\nline two\nline three"
    const diff = parseUnifiedDiff(`--- a/f.ts
+++ b/f.ts
@@ -1,3 +1,4 @@
 line one
+inserted
 line two
 line three
`)
    const result = applyFileDiff(original, diff[0])
    expect(result).toBe("line one\ninserted\nline two\nline three")
  })

  it("applies a deletion", () => {
    const original = "a\nb\nc\nd"
    const diff = parseUnifiedDiff(`--- a/f.ts
+++ b/f.ts
@@ -1,4 +1,3 @@
 a
-b
 c
 d
`)
    const result = applyFileDiff(original, diff[0])
    expect(result).toBe("a\nc\nd")
  })

  it("applies a replacement", () => {
    const original = "foo\nbar\nbaz"
    const diff = parseUnifiedDiff(`--- a/f.ts
+++ b/f.ts
@@ -1,3 +1,3 @@
 foo
-bar
+BAR
 baz
`)
    const result = applyFileDiff(original, diff[0])
    expect(result).toBe("foo\nBAR\nbaz")
  })

  it("handles positional shift (fuzzy ±10)", () => {
    // Original has 5 extra lines at top compared to what the hunk expects at line 1
    const original = "x\nx\nx\nx\nx\nfoo\nbar\nbaz"
    const diff = parseUnifiedDiff(`--- a/f.ts
+++ b/f.ts
@@ -1,3 +1,3 @@
 foo
-bar
+BAR
 baz
`)
    // Hunk says line 1 but actual location is line 6 — within ±10 linear scan
    const result = applyFileDiff(original, diff[0])
    expect(result).toBe("x\nx\nx\nx\nx\nfoo\nBAR\nbaz")
  })

  it("uses fuzzy matcher as fallback", () => {
    const original = "  foo\n  bar\n  baz"
    // Diff expects "foo\nbar\nbaz" (no indent) — won't match positionally
    const diff = parseUnifiedDiff(`--- a/f.ts
+++ b/f.ts
@@ -1,3 +1,3 @@
 foo
-bar
+BAR
 baz
`)
    const fuzzyMatcher: FuzzyMatcher = {
      findAndReplace: (_content, _old, newStr) => ({
        success: true,
        result: `  foo\n  BAR\n  baz`,
      }),
    }
    const result = applyFileDiff(original, diff[0], fuzzyMatcher)
    expect(result).toBe("  foo\n  BAR\n  baz")
  })

  it("skips unmatched hunks gracefully", () => {
    const original = "aaa\nbbb\nccc"
    const diff = parseUnifiedDiff(`--- a/f.ts
+++ b/f.ts
@@ -1,3 +1,3 @@
 xxx
-yyy
+zzz
 www
`)
    // None of the context matches — hunk is skipped
    const result = applyFileDiff(original, diff[0])
    expect(result).toBe("aaa\nbbb\nccc")
  })
})

// ── extractDiff tests ────────────────────────────────────────────────────────

describe("extractDiff", () => {
  it("extracts fenced diff block", () => {
    const text = 'Here is the diff:\n```diff\n--- a/foo.ts\n+++ b/foo.ts\n@@ -1 +1 @@\n-old\n+new\n```\nDone.'
    const result = extractDiff(text)
    expect(result).toContain("--- a/foo.ts")
    expect(result).toContain("+new")
  })

  it("extracts bare unified diff", () => {
    const text = '--- a/foo.ts\n+++ b/foo.ts\n@@ -1 +1 @@\n-old\n+new\n'
    const result = extractDiff(text)
    expect(result).toContain("--- a/foo.ts")
  })

  it("returns null for no diff", () => {
    expect(extractDiff("no diff here")).toBeNull()
  })
})

// ── extractConfidence tests ──────────────────────────────────────────────────

describe("extractConfidence", () => {
  it("extracts valid confidence block", () => {
    const text = '```json\n{"score": 0.85, "reason": "Good", "uncertainties": ["edge case"]}\n```'
    const result = extractConfidence(text)
    expect(result.score).toBe(0.85)
    expect(result.reason).toBe("Good")
    expect(result.uncertainties).toEqual(["edge case"])
  })

  it("clamps score to [0, 1]", () => {
    const text = '```json\n{"score": 1.5, "reason": "overconfident", "uncertainties": []}\n```'
    expect(extractConfidence(text).score).toBe(1)

    const text2 = '```json\n{"score": -0.3, "reason": "negative", "uncertainties": []}\n```'
    expect(extractConfidence(text2).score).toBe(0)
  })

  it("returns default when no json block", () => {
    const result = extractConfidence("just some text without json")
    expect(result.score).toBe(0.5)
    expect(result.uncertainties).toHaveLength(1)
  })

  it("returns default on malformed json", () => {
    const text = '```json\n{broken json here}\n```'
    const result = extractConfidence(text)
    expect(result.score).toBe(0.5)
  })
})

// ── MutatorImpl integration tests ────────────────────────────────────────────

describe("MutatorImpl", () => {
  it("succeeds on first round with valid diff", async () => {
    const deps = makeDeps()
    const mutator = new MutatorImpl(deps)
    const intent = makeIntent()

    const result = await mutator.mutate(intent)

    expect(result.success).toBe(true)
    expect(result.rounds).toBe(1)
    expect(result.changedFiles).toContain("src/frobulator.ts")
    expect(result.confidence.score).toBe(0.9)
  })

  it("returns failure when no target files exist", async () => {
    const deps = makeDeps({
      fs: {
        exists: () => false,
        read: () => "",
        write: vi.fn(),
      },
    })
    const mutator = new MutatorImpl(deps)
    const intent = makeIntent()

    const result = await mutator.mutate(intent)

    expect(result.success).toBe(false)
    expect(result.rounds).toBe(0)
    expect(result.error).toContain("None of the target files exist")
  })

  it("retries when LLM produces no diff", async () => {
    const llmResponses = [
      "I think we should change it but here's no diff", // round 1: no diff
      '```diff\n--- a/src/frobulator.ts\n+++ b/src/frobulator.ts\n@@ -1,3 +1,4 @@\n export function frob(x: string) {\n+  if (!x) return ""\n   return x.trim()\n }\n```\n\n```json\n{"score": 0.8, "reason": "ok", "uncertainties": []}\n```',
    ]
    let callCount = 0
    const deps = makeDeps({
      llm: {
        chat: vi.fn().mockImplementation(async () => llmResponses[callCount++]),
      },
    })
    const mutator = new MutatorImpl(deps)
    const intent = makeIntent()

    const result = await mutator.mutate(intent)

    expect(result.success).toBe(true)
    expect(result.rounds).toBe(2)
    expect(deps.llm.chat).toHaveBeenCalledTimes(2)
  })

  it("retries on TypeScript errors and succeeds", async () => {
    let tscCallCount = 0
    const deps = makeDeps({
      typeChecker: {
        check: () => {
          tscCallCount++
          if (tscCallCount === 1)
            return { success: false, output: "Type error at line 2" }
          return { success: true, output: "" }
        },
      },
      llm: {
        chat: vi.fn().mockResolvedValue(
          '```diff\n--- a/src/frobulator.ts\n+++ b/src/frobulator.ts\n@@ -1,3 +1,4 @@\n export function frob(x: string) {\n+  if (!x) return ""\n   return x.trim()\n }\n```\n\n```json\n{"score": 0.85, "reason": "fixed", "uncertainties": []}\n```',
        ),
      },
    })
    const mutator = new MutatorImpl(deps)
    const intent = makeIntent()

    const result = await mutator.mutate(intent)

    expect(result.success).toBe(true)
    expect(result.rounds).toBe(2)
  })

  it("fails after exhausting all rounds", async () => {
    const deps = makeDeps({
      typeChecker: {
        check: () => ({ success: false, output: "Persistent error" }),
      },
      llm: {
        chat: vi.fn().mockResolvedValue(
          '```diff\n--- a/src/frobulator.ts\n+++ b/src/frobulator.ts\n@@ -1,3 +1,4 @@\n export function frob(x: string) {\n+  bad code\n   return x.trim()\n }\n```\n\n```json\n{"score": 0.3, "reason": "unsure", "uncertainties": ["might not compile"]}\n```',
        ),
      },
      config: { maxRounds: 2, confidenceThreshold: 0.7, repoRoot: "/repo" },
    })
    const mutator = new MutatorImpl(deps)
    const intent = makeIntent()

    const result = await mutator.mutate(intent)

    expect(result.success).toBe(false)
    expect(result.rounds).toBe(2)
    expect(result.error).toContain("TypeScript errors")
  })

  it("handles LLM call failure gracefully", async () => {
    const deps = makeDeps({
      llm: {
        chat: vi.fn().mockRejectedValue(new Error("Network timeout")),
      },
    })
    const mutator = new MutatorImpl(deps)
    const intent = makeIntent()

    const result = await mutator.mutate(intent)

    expect(result.success).toBe(false)
    expect(result.error).toContain("LLM call failed: Network timeout")
    expect(result.rounds).toBe(1)
  })

  it("restores original files after tsc failure before next round", async () => {
    const writeLog: Array<{ path: string; content: string }> = []
    const fileStore: Record<string, string> = {
      "/repo/src/frobulator.ts": "original content\n",
    }

    let round = 0
    const deps = makeDeps({
      fs: {
        exists: (p) => p in fileStore,
        read: (p) => fileStore[p] ?? "",
        write: (p, c) => {
          writeLog.push({ path: p, content: c })
          fileStore[p] = c
        },
      },
      typeChecker: {
        check: () => {
          round++
          if (round === 1) return { success: false, output: "error" }
          return { success: true, output: "" }
        },
      },
      llm: {
        chat: vi.fn().mockResolvedValue(
          '```diff\n--- a/src/frobulator.ts\n+++ b/src/frobulator.ts\n@@ -1,1 +1,2 @@\n original content\n+new line\n```\n\n```json\n{"score": 0.8, "reason": "ok", "uncertainties": []}\n```',
        ),
      },
    })
    const mutator = new MutatorImpl(deps)
    const intent = makeIntent()

    await mutator.mutate(intent)

    // After first round failure, the original file should be restored
    // (second write to the file path should be the original content)
    const frobWrites = writeLog.filter(
      (w) => w.path === "/repo/src/frobulator.ts",
    )
    expect(frobWrites.length).toBeGreaterThanOrEqual(2)
    // The restore write (index 1) should be original content
    expect(frobWrites[1].content).toBe("original content\n")
  })

  it("reports git commit failure but still returns success", async () => {
    const deps = makeDeps({
      git: {
        add: vi.fn(),
        commit: () => ({ success: false, error: "git lock" }),
      },
    })
    const mutator = new MutatorImpl(deps)
    const intent = makeIntent()

    const result = await mutator.mutate(intent)

    // Mutation itself succeeded (files modified, tsc passed)
    expect(result.success).toBe(true)
    expect(deps.logger.warn).toHaveBeenCalledWith(
      "Git commit failed: %s",
      "git lock",
    )
  })
})
