// src/guidance/memory-manager.ts
import type { Db } from "../db/client.js"
import { randomUUID } from "crypto"

export interface MemSession {
  sessionId: string // 隔离临时 session（mem-<uuid>）
  targetAgentId: string // 被管理的 agent
  targetAgentName: string
}

export const MEMORY_MANAGER_PROMPT = `你是「记忆管家」，专门帮助用户查看和整理当前助手的记忆。
你可以用 memory_inspect 查看记忆全景，用 memory_edit 编辑各记忆层。
记忆分为：
- 全局固定区 / 私人固定区（不可压缩，谨慎修改，改动需 confirm）
- 全局非固定区 / 私人非固定区（可压缩，可自由整理）
- 公共知识库（跨助手共享）
请先用 memory_inspect 了解现状，再根据用户意图精准编辑。每次编辑后复述你做了什么。
注意：你在隔离会话中工作，这里的对话不会进入原助手的记忆。`

export class MemoryManagerSession {
  private active = new Map<string, MemSession>() // userId -> session
  constructor(private db: Db) {}

  enter(userId: string, targetAgentId: string, targetAgentName: string): MemSession {
    const s: MemSession = {
      sessionId: `mem-${randomUUID().slice(0, 12)}`,
      targetAgentId,
      targetAgentName,
    }
    this.active.set(userId, s)
    return s
  }

  exit(userId: string): void {
    const s = this.active.get(userId)
    if (s) {
      // 清理隔离 session 的临时消息（若曾落盘）
      try {
        this.db.prepare(`DELETE FROM chat_messages WHERE session_id = ?`).run(s.sessionId)
      } catch {}
      try {
        this.db.prepare(`DELETE FROM chat_sessions WHERE id = ?`).run(s.sessionId)
      } catch {}
    }
    this.active.delete(userId)
  }

  isActive(userId: string): boolean {
    return this.active.has(userId)
  }
  getActive(userId: string): MemSession | null {
    return this.active.get(userId) ?? null
  }
}
