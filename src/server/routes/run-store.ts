// src/server/routes/run-store.ts
// In-memory store for async run state.
// Runs are ephemeral — lost on restart. Sufficient for async chat use case.

import { randomUUID } from "crypto"

export type RunStatus = "pending" | "running" | "completed" | "failed"

export interface Run {
  id: string
  status: RunStatus
  result?: string
  error?: string
  createdAt: number
}

export class RunStore {
  private runs = new Map<string, Run>()

  create(): string {
    const id = randomUUID()
    this.runs.set(id, { id, status: "pending", createdAt: Date.now() })
    return id
  }

  get(id: string): Run | undefined {
    return this.runs.get(id)
  }

  setRunning(id: string): void {
    const run = this.runs.get(id)
    if (run) run.status = "running"
  }

  complete(id: string, result: string): void {
    const run = this.runs.get(id)
    if (run) { run.status = "completed"; run.result = result }
  }

  fail(id: string, error: string): void {
    const run = this.runs.get(id)
    if (run) { run.status = "failed"; run.error = error }
  }
}
