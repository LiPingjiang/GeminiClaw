import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { tmpdir } from "os"
import { join } from "path"
import { randomUUID } from "crypto"
import { EvolutionDB } from "../db.js"
import { TraceAnalyzer } from "./trace-analyzer.js"

function tmpDbPath(): string {
  return join(tmpdir(), `trace-analyzer-test-${randomUUID()}.db`)
}

describe("TraceAnalyzer", () => {
  let db: EvolutionDB
  let dbPath: string
  let analyzer: TraceAnalyzer

  beforeEach(() => {
    dbPath = tmpDbPath()
    db = new EvolutionDB(dbPath)
    analyzer = new TraceAnalyzer(db)
  })

  afterEach(() => {
    // Temp files are cleaned up by OS eventually; no explicit cleanup needed
  })

  it("returns empty array when no traces", () => {
    const intents = analyzer.analyze()
    expect(intents).toEqual([])
  })

  it("returns empty array when failure rate is below threshold", () => {
    for (let i = 0; i < 10; i++) {
      db.insertTrace({
        id: `trace-${i}`,
        sessionId: "s1",
        toolSequence: ["read", "write"],
        hadFailure: false,
        responseLength: 100,
        messageCount: 2,
        recordedAt: Date.now() - i * 1000,
      })
    }
    const intents = analyzer.analyze()
    expect(intents).toEqual([])
  })

  it("generates behavior_fix intent when failure rate exceeds threshold", () => {
    for (let i = 0; i < 10; i++) {
      db.insertTrace({
        id: `trace-${i}`,
        sessionId: "s1",
        toolSequence: ["exec", "read"],
        hadFailure: i < 6,
        responseLength: 100,
        messageCount: 2,
        recordedAt: Date.now() - i * 1000,
      })
    }
    const intents = analyzer.analyze()
    expect(intents).toHaveLength(1)
    expect(intents[0].type).toBe("behavior_fix")
    expect(intents[0].riskLevel).toBe("low")
    expect(intents[0].status).toBe("pending")
    expect(intents[0].evidence.length).toBeGreaterThan(0)
    expect(intents[0].evidence.join(" ")).toContain("60%")
  })

  it("respects custom failure rate threshold", () => {
    for (let i = 0; i < 10; i++) {
      db.insertTrace({
        id: `trace-${i}`,
        sessionId: "s1",
        toolSequence: ["exec"],
        hadFailure: i < 3,
        responseLength: 100,
        messageCount: 1,
        recordedAt: Date.now() - i * 1000,
      })
    }
    const analyzer2 = new TraceAnalyzer(db, { failureRateThreshold: 0.5 })
    const intents = analyzer2.analyze()
    expect(intents).toEqual([])
  })

  it("skips analysis when trace count is below minTraces", () => {
    db.insertTrace({
      id: "trace-0",
      sessionId: "s1",
      toolSequence: ["exec"],
      hadFailure: true,
      responseLength: 100,
        messageCount: 1,
      recordedAt: Date.now(),
    })
    const intents = analyzer.analyze()
    expect(intents).toEqual([])
  })
})
