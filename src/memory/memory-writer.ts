// src/memory/memory-writer.ts
import { appendFileSync, mkdirSync, readFileSync, existsSync } from "fs";
import { dirname } from "path";
import type { MemoryPaths } from "./paths.js";

const MAX_PART = 600; // chars per side

/** Patterns that indicate a broken/looping response that should NOT be persisted */
const SKIP_PATTERNS = [
  "（检测到空转",
  "检测到循环",
  "（检测到重复",
];

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

    // ── Guard 1: skip broken/looping responses ──
    if (SKIP_PATTERNS.some(p => assistantText.includes(p))) {
      return;
    }

    // ── Guard 2: skip if assistant reply duplicates the last diary entry ──
    const globalPath = this.paths.globalDaily(date);
    if (this._isDuplicateOfLast(globalPath, assistantText)) {
      return;
    }

    const u = this._clip(userText);
    const a = this._clip(assistantText);
    if (!u && !a) return;
    const time = new Date().toISOString().slice(11, 16);
    const entry = `\n## ${date} ${time}\n- 用户：${u}\n- 助手：${a}\n`;

    this._append(globalPath, entry);

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

  /**
   * Read the last diary entry's assistant text and compare with the new one.
   * Returns true if the new assistant reply is substantially the same as the last recorded one.
   */
  private _isDuplicateOfLast(dailyPath: string, newAssistant: string): boolean {
    if (!existsSync(dailyPath)) return false;
    try {
      const content = readFileSync(dailyPath, "utf-8");
      // Find the last "- 助手：" line
      const lines = content.split("\n");
      let lastAssistant = "";
      for (let i = lines.length - 1; i >= 0; i--) {
        if (lines[i].startsWith("- 助手：")) {
          lastAssistant = lines[i].slice(5); // remove "- 助手："
          break;
        }
      }
      if (!lastAssistant) return false;
      // Compare first 120 chars (enough to detect repeats)
      const newClip = newAssistant.trim().replace(/\n+/g, " ").slice(0, 120);
      const lastClip = lastAssistant.trim().slice(0, 120);
      return newClip === lastClip;
    } catch {
      return false;
    }
  }
}
