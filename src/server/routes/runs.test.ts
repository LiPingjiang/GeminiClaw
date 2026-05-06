import { describe, it, expect, beforeEach, afterEach } from "vitest"
import Fastify from "fastify"
import { runsRoute } from "./runs.js"
import { RunStore } from "./run-store.js"

describe("runsRoute", () => {
  let app: ReturnType<typeof Fastify>
  let store: RunStore

  beforeEach(async () => {
    store = new RunStore()
    app = Fastify()
    await app.register(runsRoute, { runStore: store })
    await app.ready()
  })

  afterEach(async () => {
    await app.close()
  })

  it("GET /v1/runs/:id/events returns 404 for unknown run", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/runs/nonexistent/events" })
    expect(res.statusCode).toBe(404)
  })

  it("GET /v1/runs/:id/events returns 200 with SSE for completed run", async () => {
    const id = store.create()
    store.complete(id, "hello world")

    const res = await app.inject({ method: "GET", url: `/v1/runs/${id}/events` })
    expect(res.statusCode).toBe(200)
    expect(res.headers["content-type"]).toContain("text/event-stream")
    expect(res.body).toContain("hello world")
  })

  it("GET /v1/runs/:id/events returns error event for failed run", async () => {
    const id = store.create()
    store.fail(id, "something went wrong")

    const res = await app.inject({ method: "GET", url: `/v1/runs/${id}/events` })
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain("something went wrong")
    expect(res.body).toContain("error")
  })
})
