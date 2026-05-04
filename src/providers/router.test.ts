import { describe, it, expect, vi } from "vitest"
import { ProviderRouter } from "./router.js"
import type { Provider, Message, ChatResponse } from "./types.js"

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
    fallback: ["p1/m1", "p2/m2"],
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
