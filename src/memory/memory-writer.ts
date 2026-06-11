// src/memory/memory-writer.ts
import { appendFileSync, mkdirSync } from "fs";
import { dirname } from "path";
import type { MemoryPaths } from "./paths.js";

const MAX_PART = 600; // chars per side

export interface RecordTurnParams {
  userText: string;
  assistantText: string;
  date: string;
  agentId?: string;
}

/**
 * Persists each conversation turn into the daily memory file so that
 * memory_search and working-memory injection have real data to draw on.
 * Append-only, idempotent-accumulate, never overwrites.
 */
export class MemoryWriter {
  constructor(private readonly paths: MemoryPaths) {}

  async recordTurn(params: RecordTurnParams): Promise<void> {
    const { userText, assistantText, date, agentId } = params;
    const u = this._clip(userText);
    const a = this._clip(assistantText);
    if (!u && !a) return;
    const time = new Date().toISOString().slice(11, 16);
    const entry = `\n## ${date} ${time}\n- 用户：${u}\n- 助手：${a}\n`;

    this._append(this.paths.globalDaily(date), entry);

    if (agentId) {
      this._append(this.paths.agentDaily(agentId, date), entry);
    }
  }

  private _clip(s: string): string {
    const t = (s || "").trim().replace(/\n+/g, " ");
    return t.length > MAX_PART ? t.slice(0, MAX_PART) + "…" : t;
  }

  private _append(path: string, entry: string): void {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, entry, "utf-8");
  }
}
