// src/providers/mcli.test.ts
import { it, expect, vi, beforeEach } from "vitest"
import Anthropic from "@anthropic-ai/sdk"

vi.mock("@anthropic-ai/sdk")

function makeConfig(headers?: Record<string, string>) {
  return {
    name: "mcli",
    type: "mcli" as const,
    apiKey: "test-key",
    baseUrl: "https://mcli.example.com",
    models: ["claude-opus-4-6"],
    headers,
  }
}

beforeEach(() => {
  vi.mocked(Anthropic).mockClear()
})

it("passes defaultHeaders to Anthropic client when headers configured", async () => {
  const { McliProvider } = await import("./mcli.js")
  new McliProvider(makeConfig({ "X-Working-Dir": "/home/user" }))

  expect(vi.mocked(Anthropic)).toHaveBeenCalledWith(
    expect.objectContaining({
      defaultHeaders: { "X-Working-Dir": "/home/user" },
    }),
  )
})

it("passes empty defaultHeaders when no headers configured", async () => {
  const { McliProvider } = await import("./mcli.js")
  new McliProvider(makeConfig())

  expect(vi.mocked(Anthropic)).toHaveBeenCalledWith(
    expect.objectContaining({
      defaultHeaders: {},
    }),
  )
})

it("uses apiKey from config", async () => {
  const { McliProvider } = await import("./mcli.js")
  new McliProvider(makeConfig())

  expect(vi.mocked(Anthropic)).toHaveBeenCalledWith(
    expect.objectContaining({ apiKey: "test-key" }),
  )
})

it("falls back to 'mcli' when no apiKey", async () => {
  const { McliProvider } = await import("./mcli.js")
  new McliProvider({ ...makeConfig(), apiKey: undefined })

  expect(vi.mocked(Anthropic)).toHaveBeenCalledWith(
    expect.objectContaining({ apiKey: "mcli" }),
  )
})
