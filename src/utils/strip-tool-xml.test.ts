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

  it("does NOT false-positive on Markdown tables", () => {
    const input = `## 📊 真实进展汇总（2026-06-14）
### ✅ 已完成：16批任务（80个角度）
| 批次 | 内容 | 关键结果 |
|-----|------|----------|
| P1-P5 | 五层完整验证 | P1 HK Sharpe 2.82 |
| P6-P8 | 策略优化 | 收益提升15% |
| P9-P12 | 风控测试 | 最大回撤3.2% |
| P13-P16 | 实盘模拟 | 胜率68% |

### 📋 进行中
| 任务 | 状态 | 预计完成 |
|-----|------|----------|
| P17 数据清洗 | 进行中 | 今日 |
| P18 回测验证 | 排队中 | 明日 |
| P19 信号优化 | 排队中 | 后日 |

### 🔜 待启动
| 任务 | 依赖 | 优先级 |
|-----|------|--------|
| P20 全市场扫描 | P17完成 | 高 |
| P21 组合优化 | P18完成 | 中 |`
    expect(detectRepetitionLoop(input)).toBeNull()
  })

  it("does NOT false-positive on multiple similar table rows", () => {
    const rows = Array(10).fill("| 数据项 | 正常 | 2026-06-14 |").join("\n")
    const input = `## 状态报告\n| 项目 | 状态 | 日期 |\n|-----|------|------|\n${rows}`
    expect(detectRepetitionLoop(input)).toBeNull()
  })

  it("still detects genuine repetition loops", () => {
    const block = "让我检查一下数据库状态。正在连接数据库并查询最新记录。"
    const input = "好的，开始检查：\n" + Array(8).fill(block).join("\n")
    const result = detectRepetitionLoop(input)
    expect(result).not.toBeNull()
    expect(result!.length).toBeLessThan(input.length)
  })
})
