import { describe, it, expect } from "vitest"
import { MemoryTopicsAnalyzer } from "./memory-topics-analyzer.js"

describe("MemoryTopicsAnalyzer", () => {
  it("returns empty array when dbPath does not exist", () => {
    const analyzer = new MemoryTopicsAnalyzer("/nonexistent/path/db.sqlite")
    const intents = analyzer.analyze()
    expect(intents).toEqual([])
  })

  it("returns empty array for :memory: path (no real file)", () => {
    const analyzer = new MemoryTopicsAnalyzer(":memory:")
    const intents = analyzer.analyze()
    expect(intents).toEqual([])
  })
})
