// @ts-nocheck
// src/server/routes/run-store.ts
// In-memory store for async run state.
// Runs are ephemeral — lost on restart. Sufficient for async chat use case.
import { randomUUID } from "crypto";
export class RunStore {
    runs = new Map();
    create() {
        const id = randomUUID();
        this.runs.set(id, { id, status: "pending", createdAt: Date.now() });
        return id;
    }
    get(id) {
        return this.runs.get(id);
    }
    setRunning(id) {
        const run = this.runs.get(id);
        if (run)
            run.status = "running";
    }
    complete(id, result) {
        const run = this.runs.get(id);
        if (run) {
            run.status = "completed";
            run.result = result;
        }
    }
    fail(id, error) {
        const run = this.runs.get(id);
        if (run) {
            run.status = "failed";
            run.error = error;
        }
    }
}
