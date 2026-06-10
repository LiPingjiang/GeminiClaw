import { describe, it, expect } from "vitest"
import { stripToolXml, detectRepetitionLoop } from "./strip-tool-xml.js"

describe("stripToolXml", () => {
  it("strips tool_call tags", () => {
    const input = "Hello <tool_call>exec {}</tool_call> world"
    expect(stripToolXml(input)).toBe("Hello  world")
  })

  it("strips antThinking tags", () => {
    const input = "Start <antThinking>some internal reasoning</antThinking> End"
    expect(stripToolXml(input)).toBe("Start  End")
  })

  it("strips multiple antThinking blocks", () => {
    const input = "Answer <antThinking>thought 1</antThinking><antThinking>thought 2</antThinking> done"
    expect(stripToolXml(input)).toBe("Answer  done")
  })

  it("strips thinking tags", () => {
    const input = "Before <thinking>reasoning here</thinking> After"
    expect(stripToolXml(input)).toBe("Before  After")
  })

  it("strips unclosed antThinking (truncates from tag onward)", () => {
    const input = "Good content <antThinking>this never closes and loops forever..."
    expect(stripToolXml(input)).toBe("Good content")
  })

  it("strips via regex for variant casing", () => {
    const input = "Hello <AntThinking>test</AntThinking> world"
    expect(stripToolXml(input)).toBe("Hello  world")
  })

  it("handles empty string", () => {
    expect(stripToolXml("")).toBe("")
  })

  it("handles text without any tags", () => {
    expect(stripToolXml("Just normal text")).toBe("Just normal text")
  })

  it("handles real-world agnes output with many antThinking blocks", () => {
    const blocks = Array(50).fill("<antThinking>\n让我先检查本地数据库。\n</antThinking>").join("\n")
    const input = `开始执行检查：\n\n${blocks}`
    const result = stripToolXml(input)
    expect(result).toBe("开始执行检查：")
    expect(result).not.toContain("antThinking")
  })
})

describe("detectRepetitionLoop", () => {
  it("returns null for normal text", () => {
    expect(detectRepetitionLoop("This is perfectly normal text that doesn't repeat.")).toBeNull()
  })

  it("returns null for short text", () => {
    expect(detectRepetitionLoop("short")).toBeNull()
  })

  it("detects obvious repetition loop", () => {
    const block = "我需要检查本地数据库的最新数据时间。让我先执行本地数据库检查。"
    const input = "好的，开始检查。" + block.repeat(5)
    const result = detectRepetitionLoop(input, 40, 3)
    expect(result).not.toBeNull()
    // Should return content before the repetition starts
    expect(result!.length).toBeLessThan(input.length)
  })

  it("detects antThinking repetition pattern", () => {
    const block = "让我先检查本地数据库的最新数据。先执行本地检查。"
    const input = "执行检查：\n" + Array(10).fill(block).join("\n")
    const result = detectRepetitionLoop(input, 40, 3)
    expect(result).not.toBeNull()
  })

  it("returns null when text is too short for detection", () => {
    expect(detectRepetitionLoop("abc".repeat(10), 40, 3)).toBeNull()
  })
})
