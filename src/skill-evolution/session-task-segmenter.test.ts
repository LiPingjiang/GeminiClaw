/**
 * Tests for SessionTaskSegmenter.
 *
 * The segmenter has two stages:
 *   1. distill (no LLM) — keep each user msg + the final assistant reply of its
 *      turn; drop intermediate tool steps.
 *   2. segment (LLM) — draw task boundaries over the distilled sequence, with
 *      day-aligned batching and rolling state across batches.
 *
 * We stub the LLM so the tests are deterministic and offline. The stub echoes
 * the rolling protocol: it reads the message ids present in each batch and emits
 * a valid task-list JSON, accumulating across batches.
 */
import { describe, it, expect } from "vitest"
import {
  SessionTaskSegmenter,
  estimateTokens,
  type SegmenterMessage,
} from "./session-task-segmenter.js"
import type { LlmClient, LlmMessage } from "./types.js"

// ── helpers ───────────────────────────────────────────────────────────────────

let nextId = 1
function msg(
  role: SegmenterMessage["role"],
  content: string,
  day = "2026-06-04",
  time = "10:00:00",
): SegmenterMessage {
  return { id: nextId++, role, content, created_at: `${day} ${time}` }
}

function turn(
  user: string,
  reply: string,
  day = "2026-06-04",
  time = "10:00:00",
): SegmenterMessage[] {
  return [
    msg("user", user, day, time),
    msg("tool", "some tool noise", day, time), // intermediate, should be dropped
    msg("assistant", reply, day, time),
  ]
}

/** Reset the id counter so each test gets deterministic ids starting at 1. */
function fresh(): void {
  nextId = 1
}

/**
 * A stub LLM that puts every turn id in the batch into ONE task per batch.
 * It honours the rolling protocol: it carries forward the existing "TASK|..."
 * lines from the prompt and appends one new task for this batch.
 */
class OneTaskPerBatchLlm implements LlmClient {
  public calls = 0
  async chat(messages: LlmMessage[]): Promise<string> {
    this.calls++
    const user = messages.find((m) => m.role === "user")?.content ?? ""

    // Carry forward existing TASK| lines from the prompt's rolling block.
    const existing = [...user.matchAll(/^TASK\|.*$/gm)].map((m) => m[0])

    // Collect this batch's turn ids from the [#<id> ...] markers.
    const ids = [...user.matchAll(/\[#(\d+)\s/g)].map((m) => Number(m[1]))
    const startId = Math.min(...ids)
    const endId = Math.max(...ids)
    const idx = existing.length + 1
    const newTask = `TASK|${idx}|${startId}|${endId}|${ids.length}|batch task ${idx}::stub`
    return [...existing, newTask].join("\n")
  }
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe("SessionTaskSegmenter", () => {
  it("estimateTokens weighs CJK heavier than ascii", () => {
    expect(estimateTokens("你好世界")).toBeGreaterThan(estimateTokens("abcd"))
  })

  it("returns [] when there are no user turns", async () => {
    fresh()
    const seg = new SessionTaskSegmenter(new OneTaskPerBatchLlm())
    const out = await seg.segment([msg("assistant", "hi"), msg("tool", "noise")])
    expect(out).toEqual([])
  })

  it("distills turns and produces task ranges over message ids", async () => {
    fresh()
    const llm = new OneTaskPerBatchLlm()
    const messages = [...turn("do A", "did A"), ...turn("do B", "did B")]
    const seg = new SessionTaskSegmenter(llm)
    const tasks = await seg.segment(messages)

    expect(llm.calls).toBe(1) // single batch (well under cap)
    expect(tasks.length).toBe(1)
    // startId = first user id (1), endId = second user id (4).
    expect(tasks[0].startId).toBe(1)
    expect(tasks[0].endId).toBe(4)
  })

  it("splits into day-aligned batches and carries rolling state", async () => {
    fresh()
    const llm = new OneTaskPerBatchLlm()
    // Force tiny batches so each day becomes its own batch.
    const seg = new SessionTaskSegmenter(llm, { maxBatchTokens: 1 })
    const messages = [
      ...turn("day1 work", "ok day1", "2026-06-04"),
      ...turn("day2 work", "ok day2", "2026-06-05"),
      ...turn("day3 work", "ok day3", "2026-06-06"),
    ]
    const tasks = await seg.segment(messages)

    expect(llm.calls).toBe(3) // three days → three batches
    expect(tasks.length).toBe(3) // rolling: one task accumulated per batch
    // Tasks cover the whole id space, monotonically.
    expect(tasks[0].index).toBe(1)
    expect(tasks[2].index).toBe(3)
    expect(tasks[0].endId).toBeLessThan(tasks[1].startId)
    expect(tasks[1].endId).toBeLessThan(tasks[2].startId)
  })

  it("tolerates code fences and surrounding prose", async () => {
    fresh()
    const noisy: LlmClient = {
      async chat() {
        return "好的，分析如下：\n```\nTASK|1|1|4|2|标题t::目标s\n```\n以上。"
      },
    }
    const seg = new SessionTaskSegmenter(noisy)
    const tasks = await seg.segment([...turn("a", "b"), ...turn("c", "d")])
    expect(tasks.length).toBe(1)
    expect(tasks[0].title).toBe("标题t")
    expect(tasks[0].summary).toBe("目标s")
  })

  it("skips lines with non-finite ids", async () => {
    fresh()
    const bad: LlmClient = {
      async chat() {
        return ["TASK|1|1|4|2|ok::good", "TASK|2|x|null|0|bad::nope"].join("\n")
      },
    }
    const seg = new SessionTaskSegmenter(bad)
    const tasks = await seg.segment([...turn("a", "b"), ...turn("c", "d")])
    expect(tasks.length).toBe(1)
    expect(tasks[0].title).toBe("ok")
  })
})
