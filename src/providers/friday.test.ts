import { it, expect, vi, beforeEach, afterEach } from "vitest"

// mock global fetch
const fetchMock = vi.fn()
vi.stubGlobal("fetch", fetchMock)

function makeConfig() {
  return {
    name: "friday",
    type: "friday" as const,
    apiKey: "test-key",
    baseUrl: "https://aigc.example.com/v1/openai/native",
    models: ["gemini-3-flash-preview"],
  }
}

beforeEach(() => { fetchMock.mockReset() })

it("sends correct request and parses response", async () => {
  fetchMock.mockResolvedValue({
    ok: true,
    json: async () => ({
      choices: [{ message: { content: "hello friday" } }],
      model: "gemini-3-flash-preview",
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    }),
  })

  const { FridayProvider } = await import("./friday.js")
  const p = new FridayProvider(makeConfig())
  const resp = await p.chat([{ role: "user", content: "hi" }])

  expect(resp.content).toBe("hello friday")
  expect(resp.model).toBe("gemini-3-flash-preview")
  expect(fetchMock).toHaveBeenCalledOnce()

  const [url, opts] = fetchMock.mock.calls[0]
  expect(url).toBe("https://aigc.example.com/v1/openai/native/chat/completions")
  const body = JSON.parse(opts.body)
  expect(body.model).toBe("gemini-3-flash-preview")
  expect(body.messages[0].role).toBe("user")
})

it("throws on non-ok response", async () => {
  fetchMock.mockResolvedValue({
    ok: false,
    status: 429,
    text: async () => "rate limited",
  })

  const { FridayProvider } = await import("./friday.js")
  const p = new FridayProvider(makeConfig())
  await expect(p.chat([{ role: "user", content: "hi" }])).rejects.toThrow("friday API error 429")
})

it("uses first model as default", async () => {
  fetchMock.mockResolvedValue({
    ok: true,
    json: async () => ({
      choices: [{ message: { content: "ok" } }],
      model: "gemini-3-flash-preview",
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    }),
  })

  const { FridayProvider } = await import("./friday.js")
  const p = new FridayProvider(makeConfig())
  await p.chat([{ role: "user", content: "hi" }])
  const body = JSON.parse(fetchMock.mock.calls[0][1].body)
  expect(body.model).toBe("gemini-3-flash-preview")
})

// ── stream 测试 ──────────────────────────────────────────────

it("stream yields delta chunks from SSE", async () => {
  // 模拟 SSE 响应体
  const sseBody = [
    `data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n`,
    `data: {"choices":[{"delta":{"content":" world"}}]}\n\n`,
    `data: [DONE]\n\n`,
  ].join("")

  const encoder = new TextEncoder()
  const readable = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(sseBody))
      controller.close()
    },
  })

  fetchMock.mockResolvedValue({
    ok: true,
    body: readable,
  })

  const { FridayProvider } = await import("./friday.js")
  const p = new FridayProvider(makeConfig())

  const chunks: string[] = []
  for await (const chunk of p.stream([{ role: "user", content: "hi" }])) {
    if (chunk.delta) chunks.push(chunk.delta)
    if (chunk.done) break
  }

  expect(chunks).toEqual(["Hello", " world"])
})

it("stream throws on non-ok response", async () => {
  fetchMock.mockResolvedValue({
    ok: false,
    status: 503,
    text: async () => "service unavailable",
  })

  const { FridayProvider } = await import("./friday.js")
  const p = new FridayProvider(makeConfig())

  await expect(async () => {
    for await (const _ of p.stream([{ role: "user", content: "hi" }])) { /* drain */ }
  }).rejects.toThrow("friday API error 503")
})

it("stream skips malformed SSE lines", async () => {
  const sseBody = [
    `data: not-json\n\n`,
    `data: {"choices":[{"delta":{"content":"ok"}}]}\n\n`,
    `data: [DONE]\n\n`,
  ].join("")

  const encoder = new TextEncoder()
  const readable = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(sseBody))
      controller.close()
    },
  })

  fetchMock.mockResolvedValue({ ok: true, body: readable })

  const { FridayProvider } = await import("./friday.js")
  const p = new FridayProvider(makeConfig())

  const chunks: string[] = []
  for await (const chunk of p.stream([{ role: "user", content: "hi" }])) {
    if (chunk.delta) chunks.push(chunk.delta)
    if (chunk.done) break
  }

  expect(chunks).toEqual(["ok"])
})
