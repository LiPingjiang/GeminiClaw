// src/evolution/switcher/switcher.test.ts
// Unit tests for the Switcher class.
// Git commands are mocked via vi.mock.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { execSync } from "child_process"

// We need a real git repo for some tests
function initGitRepo(dir: string): void {
  execSync("git init", { cwd: dir, stdio: "pipe" })
  execSync("git config user.email 'test@test.com'", { cwd: dir, stdio: "pipe" })
  execSync("git config user.name 'Test'", { cwd: dir, stdio: "pipe" })
  // Create initial commit on main
  writeFileSync(join(dir, "README.md"), "# Test\n")
  execSync("git add .", { cwd: dir, stdio: "pipe" })
  execSync("git commit -m 'initial'", { cwd: dir, stdio: "pipe" })
  // Rename to main if not already
  try {
    execSync("git branch -m master main", { cwd: dir, stdio: "pipe" })
  } catch {
    // Already on main
  }
}

const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}

describe("Switcher", () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "switcher-test-"))
    vi.clearAllMocks()
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it("creates a Switcher instance", async () => {
    const { Switcher } = await import("./switcher.js")
    const { EvolutionDB } = await import("../db.js")

    const db = new EvolutionDB(join(tmpDir, "test.db"))
    const switcher = new Switcher({
      repoRoot: tmpDir,
      db,
      logger: mockLogger,
    })
    expect(switcher).toBeDefined()
    db.close()
  })

  it("getCurrentBranch returns a string", async () => {
    const { Switcher } = await import("./switcher.js")
    const { EvolutionDB } = await import("../db.js")

    initGitRepo(tmpDir)

    const db = new EvolutionDB(join(tmpDir, "test.db"))
    const switcher = new Switcher({
      repoRoot: tmpDir,
      db,
      logger: mockLogger,
    })

    const branch = switcher.getCurrentBranch()
    expect(typeof branch).toBe("string")
    expect(branch.length).toBeGreaterThan(0)
    db.close()
  })

  it("getCurrentBranch returns 'main' after init", async () => {
    const { Switcher } = await import("./switcher.js")
    const { EvolutionDB } = await import("../db.js")

    initGitRepo(tmpDir)

    const db = new EvolutionDB(join(tmpDir, "test.db"))
    const switcher = new Switcher({
      repoRoot: tmpDir,
      db,
      logger: mockLogger,
    })

    const branch = switcher.getCurrentBranch()
    expect(branch).toBe("main")
    db.close()
  })

  it("createEvolutionBranch creates and checks out a new branch", async () => {
    const { Switcher } = await import("./switcher.js")
    const { EvolutionDB } = await import("../db.js")

    initGitRepo(tmpDir)

    const db = new EvolutionDB(join(tmpDir, "test.db"))
    const switcher = new Switcher({
      repoRoot: tmpDir,
      db,
      logger: mockLogger,
    })

    const branchName = switcher.createEvolutionBranch("intent-123")
    expect(branchName).toBe("evolution/intent-123")
    expect(switcher.getCurrentBranch()).toBe("evolution/intent-123")
    db.close()
  })

  it("switch merges evolution branch into main and records history", async () => {
    const { Switcher } = await import("./switcher.js")
    const { EvolutionDB } = await import("../db.js")

    initGitRepo(tmpDir)

    const db = new EvolutionDB(join(tmpDir, "test.db"))
    const switcher = new Switcher({
      repoRoot: tmpDir,
      db,
      logger: mockLogger,
    })

    // Create evolution branch and add a commit
    const branchName = switcher.createEvolutionBranch("intent-456")
    writeFileSync(join(tmpDir, "new-feature.ts"), "export const x = 1\n")
    execSync("git add .", { cwd: tmpDir, stdio: "pipe" })
    execSync("git commit -m 'add feature'", {
      cwd: tmpDir,
      stdio: "pipe",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "Test",
        GIT_AUTHOR_EMAIL: "test@test.com",
        GIT_COMMITTER_NAME: "Test",
        GIT_COMMITTER_EMAIL: "test@test.com",
      },
    })

    const intent = {
      id: "intent-456",
      type: "behavior_fix" as const,
      description: "Add new feature",
      targetFiles: ["new-feature.ts"],
      evidence: [],
      riskLevel: "low" as const,
      requiresHumanApproval: false,
      status: "validating" as const,
      whyNow: "test",
      discoveredContext: "test",
      snoozeCount: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }

    // Mock scheduleRestart to not actually restart
    const scheduleRestartSpy = vi.spyOn(switcher as unknown as { scheduleRestart(): void }, "scheduleRestart").mockImplementation(() => {})

    const result = await switcher.switch(branchName, intent)

    expect(result.success).toBe(true)
    expect(result.intentId).toBe("intent-456")
    expect(switcher.getCurrentBranch()).toBe("main")

    // Check DB record
    const history = db.listEvolutionHistory(5)
    expect(history.length).toBe(1)
    expect(history[0].intentId).toBe("intent-456")
    expect(history[0].type).toBe("switch")

    scheduleRestartSpy.mockRestore()
    db.close()
  })

  it("rollback returns error when no history exists", async () => {
    const { Switcher } = await import("./switcher.js")
    const { EvolutionDB } = await import("../db.js")

    initGitRepo(tmpDir)

    const db = new EvolutionDB(join(tmpDir, "test.db"))
    const switcher = new Switcher({
      repoRoot: tmpDir,
      db,
      logger: mockLogger,
    })

    const result = await switcher.rollback()
    expect(result.success).toBe(false)
    expect(result.error).toContain("No switch record found")
    db.close()
  })
})
