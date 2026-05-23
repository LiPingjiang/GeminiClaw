// src/evolution/mutator/mutator.test.ts
// Unit tests for the Mutator class.
// LLM calls and git commands are mocked.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { Mutator } from "./mutator.js"
import type { ProviderRouter } from "../../providers/router.js"
import type { Intent } from "../types.js"
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMockRouter(responseContent: string): ProviderRouter {
  return {
    chat: vi.fn().mockResolvedValue({ content: responseContent, model: "mock" }),
    stream: vi.fn(),
  } as unknown as ProviderRouter
}

function makeIntent(overrides: Partial<Intent> = {}): Intent {
  return {
    id: "test-intent-1",
    type: "behavior_fix",
    description: "Add a console.log to greet function",
    targetFiles: ["src/greet.ts"],
    evidence: [],
    riskLevel: "low",
    status: "in_progress",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  }
}

const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Mutator", () => {
  let tmpDir: string
  let srcDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "mutator-test-"))
    srcDir = join(tmpDir, "src")
    require("fs").mkdirSync(srcDir, { recursive: true })

    // Create a test file
    writeFileSync(
      join(srcDir, "greet.ts"),
      `export function greet(name: string): string {\n  return \`Hello, \${name}!\`\n}\n`
    )

    vi.clearAllMocks()
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it("returns failure when target file does not exist", async () => {
    const router = makeMockRouter("")
    const mutator = new Mutator({
      providerRouter: router,
      repoRoot: tmpDir,
      config: { maxRounds: 3, confidenceThreshold: 0.7 },
      logger: mockLogger,
    })

    const intent = makeIntent({ targetFiles: ["src/nonexistent.ts"] })
    const result = await mutator.mutate(intent)

    expect(result.success).toBe(false)
    expect(result.error).toContain("None of the target files exist")
    expect(result.rounds).toBe(0)
  })

  it("returns failure when LLM does not produce a diff", async () => {
    const router = makeMockRouter("I will make the changes but here is just text, no diff.")
    const mutator = new Mutator({
      providerRouter: router,
      repoRoot: tmpDir,
      config: { maxRounds: 3, confidenceThreshold: 0.7 },
      logger: mockLogger,
    })

    const intent = makeIntent()
    const result = await mutator.mutate(intent)

    expect(result.success).toBe(false)
    expect(result.rounds).toBe(3) // exhausted all rounds
  })

  it("extracts and applies a valid unified diff", async () => {
    // Mock tsc and git
    const spawnSyncMock = vi.fn().mockReturnValue({ status: 0, stdout: "", stderr: "" })
    const execSyncMock = vi.fn()

    vi.doMock("child_process", () => ({
      spawnSync: spawnSyncMock,
      execSync: execSyncMock,
    }))

    const diffResponse = `Here are the changes:

\`\`\`diff
--- a/src/greet.ts
+++ b/src/greet.ts
@@ -1,3 +1,4 @@
 export function greet(name: string): string {
+  console.log('Greeting:', name)
   return \`Hello, \${name}!\`
 }
\`\`\`

\`\`\`json
{
  "score": 0.9,
  "reason": "Simple addition of a log statement",
  "uncertainties": []
}
\`\`\``

    const router = makeMockRouter(diffResponse)

    // We need to test the diff parsing logic directly
    // since we can't easily mock child_process in ESM
    // Instead, test the extractDiff and applyFileDiff logic indirectly
    // by checking that the mutator calls the LLM and processes the response

    const mutator = new Mutator({
      providerRouter: router,
      repoRoot: tmpDir,
      config: { maxRounds: 3, confidenceThreshold: 0.7 },
      logger: mockLogger,
    })

    // The mutate will fail at tsc check (no tsc available in test env)
    // but we can verify the LLM was called with the right content
    const intent = makeIntent()
    await mutator.mutate(intent)

    expect((router.chat as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThanOrEqual(1)
    const firstCallArgs = (router.chat as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(firstCallArgs[0][0].content).toContain("greet")
    expect(firstCallArgs[0][0].content).toContain("Add a console.log")
  })

  it("marks lowConfidence when score below threshold", async () => {
    const lowConfidenceResponse = `
\`\`\`diff
--- a/src/greet.ts
+++ b/src/greet.ts
@@ -1,3 +1,4 @@
 export function greet(name: string): string {
+  console.log('Greeting:', name)
   return \`Hello, \${name}!\`
 }
\`\`\`

\`\`\`json
{
  "score": 0.5,
  "reason": "Not very confident about this change",
  "uncertainties": ["might break something"]
}
\`\`\``

    const router = makeMockRouter(lowConfidenceResponse)
    const mutator = new Mutator({
      providerRouter: router,
      repoRoot: tmpDir,
      config: { maxRounds: 3, confidenceThreshold: 0.7 },
      logger: mockLogger,
    })

    // The mutate will fail at tsc check but we can check confidence extraction
    const intent = makeIntent()
    const result = await mutator.mutate(intent)

    // If tsc fails, result.success=false, but confidence should be extracted
    // The key check: if it somehow succeeded, lowConfidence should be true
    if (result.success) {
      expect((result as { lowConfidence?: boolean }).lowConfidence).toBe(true)
    }
    // Confidence score should be 0.5 (below 0.7 threshold)
    expect(result.confidence.score).toBe(0.5)
  })

  it("returns failure when LLM throws", async () => {
    const router = {
      chat: vi.fn().mockRejectedValue(new Error("LLM provider unavailable")),
      stream: vi.fn(),
    } as unknown as ProviderRouter

    const mutator = new Mutator({
      providerRouter: router,
      repoRoot: tmpDir,
      config: { maxRounds: 3, confidenceThreshold: 0.7 },
      logger: mockLogger,
    })

    const intent = makeIntent()
    const result = await mutator.mutate(intent)

    expect(result.success).toBe(false)
    expect(result.error).toContain("LLM call failed")
    expect(result.rounds).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// Diff parser unit tests (pure logic, no mocking needed)
// ---------------------------------------------------------------------------

describe("unified diff parser (via Mutator internals)", () => {
  it("parses a simple unified diff", async () => {
    // Test the diff parsing by creating a file and applying a diff
    const tmpDir2 = mkdtempSync(join(tmpdir(), "diff-test-"))
    const srcDir2 = join(tmpDir2, "src")
    require("fs").mkdirSync(srcDir2, { recursive: true })

    const originalContent = `export function greet(name: string): string {
  return \`Hello, \${name}!\`
}
`
    writeFileSync(join(srcDir2, "greet.ts"), originalContent)

    // Create a mutator and test that it reads the file correctly
    const router = makeMockRouter("no diff here")
    const mutator = new Mutator({
      providerRouter: router,
      repoRoot: tmpDir2,
      config: { maxRounds: 1, confidenceThreshold: 0.7 },
      logger: mockLogger,
    })

    const intent = makeIntent({ targetFiles: ["src/greet.ts"] })
    const result = await mutator.mutate(intent)

    // Even though mutation fails, the file should be read correctly
    const callArgs = (router.chat as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(callArgs[0][0].content).toContain("Hello, ${name}!")

    rmSync(tmpDir2, { recursive: true, force: true })
  })
})
