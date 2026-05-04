import { describe, it, expect, beforeEach } from "vitest"
import { SessionMemory } from "./session.js"

let mem: SessionMemory

beforeEach(() => { mem = new SessionMemory() })

it("returns empty array for unknown session", () => {
  expect(mem.get("unknown")).toEqual([])
})

it("appends and retrieves messages", () => {
  mem.append("s1", { role: "user", content: "hello" })
  mem.append("s1", { role: "assistant", content: "hi" })
  const msgs = mem.get("s1")
  expect(msgs).toHaveLength(2)
  expect(msgs[0].role).toBe("user")
  expect(msgs[1].content).toBe("hi")
})

it("clear removes session messages", () => {
  mem.append("s1", { role: "user", content: "hello" })
  mem.clear("s1")
  expect(mem.get("s1")).toEqual([])
})

it("generateId returns unique UUIDs", () => {
  const a = mem.generateId()
  const b = mem.generateId()
  expect(a).not.toBe(b)
  expect(a).toMatch(/^[0-9a-f-]{36}$/)
})
