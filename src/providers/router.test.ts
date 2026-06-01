import { describe, it, expect, vi } from "vitest"
import { ProviderRouter } from "./router.js"
import type { Provider, Message, ChatResponse, StreamChunk } from "./types.js"

function makeProvider(name: string, fail = false): Provider {
  return {
    name,
    chat: vi.fn().mockImplementation(async () => {
      if (fail) throw new Error(`${name} failed`)
      return { content: `reply from ${name}`, model: "test-model" } satisfies ChatResponse
    }),
    stream: vi.fn().mockImplementation(async function* () { yield { delta: "", done: true } }),
  }
}

const msgs: Message[] = [{ role: "user", content: "hello" }]

it("routes to default provider", async () => {
  const p1 = makeProvider("p1")
  const router = new ProviderRouter([p1], { default: "p1/m1", fallback: ["p1/m1"] })
  const res = await router.chat(msgs)
  expect(res.content).toBe("reply from p1")
  expect(p1.chat).toHaveBeenCalledWith(msgs, { model: "m1" })
})

it("falls back to second provider when first fails", async () => {
  const p1 = makeProvider("p1", true)
  const p2 = makeProvider("p2")
  const router = new ProviderRouter([p1, p2], {
    default: "p1/m1",
    fallback: ["p2/m2"],
  })
  const res = await router.chat(msgs)
  expect(res.content).toBe("reply from p2")
  expect(p1.chat).toHaveBeenCalledOnce()
  expect(p2.chat).toHaveBeenCalledOnce()
})

it("throws when all providers fail", async () => {
  const p1 = makeProvider("p1", true)
  const router = new ProviderRouter([p1], { default: "p1/m1", fallback: ["p1/m1"] })
  await expect(router.chat(msgs)).rejects.toThrow("All providers failed")
})

it("passes caller options (temperature) to provider", async () => {
  const p1 = makeProvider("p1")
  const router = new ProviderRouter([p1], { default: "p1/m1", fallback: ["p1/m1"] })
  await router.chat(msgs, { temperature: 0.5 })
  expect(p1.chat).toHaveBeenCalledWith(msgs, { model: "m1", temperature: 0.5 })
})

// ── stream 测试 ──────────────────────────────────────────────

it("stream() delegates to default provider", async () => {
  const chunks = [
    { delta: "hello", done: false },
    { delta: " world", done: false },
    { delta: "", done: true },
  ]

  async function* mockStream() {
    for (const c of chunks) yield c
  }

  const provider = {
    name: "p1",
    chat: vi.fn(),
    stream: vi.fn().mockReturnValue(mockStream()),
  } as unknown as Provider

  const router = new ProviderRouter([provider], { default: "p1/m1", fallback: [] })

  const received: StreamChunk[] = []
  for await (const chunk of router.stream([{ role: "user", content: "hi" }])) {
    received.push(chunk)
  }

  expect(received).toHaveLength(3)
  expect(received[0].delta).toBe("hello")
  expect(received[2].done).toBe(true)
  expect(provider.stream).toHaveBeenCalledWith(
    [{ role: "user", content: "hi" }],
    expect.objectContaining({ model: "m1" }),
  )
})

it("stream() throws when provider not found", async () => {
  const router = new ProviderRouter([], { default: "missing/m1", fallback: [] })

  await expect(async () => {
    for await (const _ of router.stream([{ role: "user", content: "hi" }])) { /* drain */ }
  }).rejects.toThrow('Provider "missing" not found')
})
