// src/memory/strategies/layered.ts
import { randomUUID } from "crypto"
import { existsSync, readFileSync } from "fs"
import { join } from "path"
import os from "os"
import type { Message } from "../../providers/types.js"
import type { MemoryStrategy, ConversationContext } from "../strategy.js"
import type { Db } from "../../db/client.js"
import type { Provider } from "../../providers/types.js"
import { TopicRouter } from "../router.js"
import type { TopicSummary } from "../router.js"
import { TriageService } from "../triage.js"
import { BackgroundService } from "../background.js"
import { buildContext } from "../context.js"

interface LayeredStrategyConfig {
  db: Db
  routerProvider: Provider
  triageProvider: Provider
  systemPrompt: string
  recentMessageLimit: number
  triageAfterTurns: number
  compactThresholdBytes: number
  maxActiveTopics: number
}

export class LayeredStrategy implements MemoryStrategy {
  readonly name = "layered"
  private db: Db
  private router: TopicRouter
  private triage: TriageService
  private background: BackgroundService
  private config: LayeredStrategyConfig

  constructor(config: LayeredStrategyConfig) {
    this.db = config.db
    this.config = config
    this.router = new TopicRouter(config.routerProvider)
    this.triage = new TriageService(config.triageProvider, {
      triageAfterTurns: config.triageAfterTurns,
    })
    this.background = new BackgroundService(config.triageProvider, config.db, {
      compactThresholdBytes: config.compactThresholdBytes,
      maxActiveTopics: config.maxActiveTopics,
    })
  }

  async ensureSession(sessionId: string): Promise<void> {
    const exists = this.db.prepare(`SELECT id FROM chat_sessions WHERE id = ?`).get(sessionId)
    if (!exists) {
      this.db.prepare(`INSERT INTO chat_sessions (id, title) VALUES (?, ?)`).run(sessionId, null)
    }
  }

  /** 动态读取 workspace memory，每轮注入最新内容 */
  private loadWorkspaceMemory(): string {
    const wsDir = join(os.homedir(), ".gemeniclaw", ".workspace")
    const parts: string[] = []

    // 长期记忆
    const memoryPath = join(wsDir, "MEMORY.md")
    if (existsSync(memoryPath)) {
      const content = readFileSync(memoryPath, "utf-8").trim()
      if (content) parts.push(`## 长期记忆（MEMORY.md）\n${content}`)
    }

    // 今日日记
    const today = new Date().toISOString().slice(0, 10)
    const dailyPath = join(wsDir, "memory", `${today}.md`)
    if (existsSync(dailyPath)) {
      const content = readFileSync(dailyPath, "utf-8").trim()
      if (content) parts.push(`## 今日日记（${today}）\n${content}`)
    }

    return parts.length > 0 ? `\n\n---\n\n${parts.join("\n\n")}` : ""
  }

  async getContext(sessionId: string, userMessage: string): Promise<ConversationContext> {
    await this.ensureSession(sessionId)

    // 1. 获取活跃事项索引
    const activeTopics = this.db.prepare(`
      SELECT id, title, summary FROM memory_topics WHERE active = 1
      ORDER BY last_accessed_at DESC LIMIT 16
    `).all() as TopicSummary[]

    // 2. 路由：找匹配事项
    const recentHistory = this.getRecentHistory(sessionId).reverse()
    const routeResult = await this.router.route(userMessage, recentHistory, activeTopics)

    // 3. 按需加载事项文档
    const topicDocs = []
    for (const match of routeResult.matches) {
      const topic = this.db.prepare(`
        SELECT id, title, summary, doc_level2, doc_level3 FROM memory_topics WHERE id = ?
      `).get(match.topicId) as {
        id: string; title: string; summary: string | null;
        doc_level2: string | null; doc_level3: string | null
      } | undefined

      if (!topic) continue

      // 更新访问记录
      this.db.prepare(`
        UPDATE memory_topics
        SET last_accessed_at = datetime('now'), access_count = access_count + 1
        WHERE id = ?
      `).run(match.topicId)

      const level = match.confidence < 0.7 ? Math.min(match.level, 2) as 1 | 2 | 3 : match.level
      const content = level === 3
        ? (topic.doc_level3 ?? topic.doc_level2 ?? topic.summary ?? "")
        : level === 2
          ? (topic.doc_level2 ?? topic.summary ?? "")
          : (topic.summary ?? "")

      if (content) {
        topicDocs.push({ topicId: topic.id, title: topic.title, level, content })
      }
    }

    // 4. 组装 context（动态注入 workspace memory）
    const workspaceMem = this.loadWorkspaceMemory()
    const messages = buildContext({
      systemPrompt: this.config.systemPrompt + workspaceMem,
      activeTopics,
      topicDocs,
      recentHistory,
      userMessage,
      recentMessageLimit: this.config.recentMessageLimit,
    })

    return { messages, strategyName: this.name }
  }

  async appendTurn(sessionId: string, userMsg: Message, assistantMsg: Message): Promise<void> {
    await this.ensureSession(sessionId)

    // 持久化消息
    this.db.prepare(`
      INSERT INTO chat_messages (session_id, role, content) VALUES (?, ?, ?)
    `).run(sessionId, userMsg.role, userMsg.content)
    this.db.prepare(`
      INSERT INTO chat_messages (session_id, role, content) VALUES (?, ?, ?)
    `).run(sessionId, assistantMsg.role, assistantMsg.content)

    // 更新 session 计数
    this.db.prepare(`
      UPDATE chat_sessions SET message_count = message_count + 2, updated_at = datetime('now') WHERE id = ?
    `).run(sessionId)

    // 立项判断
    const allMessages = this.db.prepare(`
      SELECT role, content FROM chat_messages WHERE session_id = ? ORDER BY id
    `).all(sessionId) as Message[]

    const activeTopics = this.db.prepare(`
      SELECT id, title, summary FROM memory_topics WHERE active = 1
    `).all() as TopicSummary[]

    const triageResult = await this.triage.triage(sessionId, allMessages, activeTopics)

    let topicId: string | null = null
    if (triageResult.action === "new_topic") {
      topicId = `topic_${randomUUID().replace(/-/g, "").slice(0, 12)}`
      this.db.prepare(`
        INSERT INTO memory_topics (id, title, summary) VALUES (?, ?, ?)
      `).run(topicId, triageResult.title, triageResult.summary)
    } else if (triageResult.action === "merge_topic") {
      topicId = triageResult.topicId
    }

    // 后台异步：摘要 + Compact + 清理
    this.background.runAsync(topicId, userMsg, assistantMsg)
  }

  private getRecentHistory(sessionId: string): Message[] {
    return this.db.prepare(`
      SELECT role, content FROM chat_messages
      WHERE session_id = ?
      ORDER BY id DESC LIMIT ?
    `).all(sessionId, this.config.recentMessageLimit) as Message[]
  }

  async appendMessages(sessionId: string, messages: Message[]): Promise<void> {
    await this.ensureSession(sessionId)
    const insert = this.db.prepare(
      `INSERT INTO chat_messages (session_id, role, content) VALUES (?, ?, ?)`
    )
    for (const msg of messages) {
      insert.run(sessionId, msg.role, msg.content)
    }
    this.db.prepare(
      `UPDATE chat_sessions SET message_count = message_count + ?, updated_at = datetime('now') WHERE id = ?`
    ).run(messages.length, sessionId)
  }
}