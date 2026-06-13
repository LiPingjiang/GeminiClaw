// src/memory/strategies/layered.ts
import { randomUUID } from "crypto"
import type { Message } from "../../providers/types.js"
import type { MemoryStrategy, ConversationContext } from "../strategy.js"
import type { Db } from "../../db/client.js"
import type { Provider } from "../../providers/types.js"
import { TopicRouter } from "../router.js"
import type { TopicSummary } from "../router.js"
import { TriageService } from "../triage.js"
import { BackgroundService } from "../background.js"
import { buildContext } from "../context.js"
import { MemoryPaths } from "../paths.js"
import { WorkingMemoryBuilder } from "../working-memory.js"

interface LayeredStrategyConfig {
  db: Db
  routerProvider: Provider
  triageProvider: Provider
  systemPrompt: string
  recentMessageLimit: number
  triageAfterTurns: number
  compactThresholdBytes: number
  maxActiveTopics: number
  memoryRoot?: string
}

export class LayeredStrategy implements MemoryStrategy {
  readonly name = "layered"
  private db: Db
  private router: TopicRouter
  private triage: TriageService
  private background: BackgroundService
  private config: LayeredStrategyConfig
  private wm: WorkingMemoryBuilder

  constructor(config: LayeredStrategyConfig) {
    this.db = config.db
    this.config = config
    this.wm = new WorkingMemoryBuilder(new MemoryPaths(config.memoryRoot))
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

  async getContext(sessionId: string, userMessage: string, agentId?: string): Promise<ConversationContext> {
    await this.ensureSession(sessionId)

    // 1. 获取活跃事项索引
    const activeTopics = this.db.prepare(`
      SELECT id, title, summary FROM public_knowledge WHERE active = 1
      ORDER BY last_accessed_at DESC LIMIT 16
    `).all() as TopicSummary[]

    // 2. 路由：找匹配事项
    const recentHistory = this.getRecentHistory(sessionId).reverse()
    const routeResult = await this.router.route(userMessage, recentHistory, activeTopics)

    // 3. 按需加载事项文档
    const topicDocs = []
    for (const match of routeResult.matches) {
      const topic = this.db.prepare(`
        SELECT id, title, summary, doc_level2, doc_level3 FROM public_knowledge WHERE id = ?
      `).get(match.topicId) as {
        id: string; title: string; summary: string | null;
        doc_level2: string | null; doc_level3: string | null
      } | undefined

      if (!topic) continue

      // 更新访问记录
      this.db.prepare(`
        UPDATE public_knowledge
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
    const _date = new Date().toISOString().slice(0, 10)
    const _mem = agentId
      ? this.wm.renderSystemPrompt(agentId, _date, "")
      : this.wm.renderGlobalOnly(_date)
    const workspaceMem = _mem ? `\n\n---\n\n${_mem}` : ""
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
      SELECT id, title, summary FROM public_knowledge WHERE active = 1
    `).all() as TopicSummary[]

    const triageResult = await this.triage.triage(sessionId, allMessages, activeTopics)

    let topicId: string | null = null
    if (triageResult.action === "new_topic") {
      topicId = `topic_${randomUUID().replace(/-/g, "").slice(0, 12)}`
      this.db.prepare(`
        INSERT INTO public_knowledge (id, title, summary) VALUES (?, ?, ?)
      `).run(topicId, triageResult.title, triageResult.summary)
    } else if (triageResult.action === "merge_topic") {
      topicId = triageResult.topicId
    }

    // 后台异步：摘要 + Compact + 清理
    this.background.runAsync(topicId, userMsg, assistantMsg)
  }

  private getRecentHistory(sessionId: string): Message[] {
    // 只加载 user/assistant 消息，跳过 tool 角色（中间工具结果）
    // 原因：tool 消息缺少 tool_call_id 结构，LLM 无法理解；
    // 且会占用 recentMessageLimit 配额，导致真正的对话上下文过少
    const raw = this.db.prepare(`
      SELECT role, content FROM chat_messages
      WHERE session_id = ? AND role IN ('user', 'assistant')
      ORDER BY id DESC LIMIT ?
    `).all(sessionId, this.config.recentMessageLimit) as Message[]

    // 去重：去除重复的 assistant 内容（防止 LLM 复制模式）
    // 场景：旧数据中同一 tool-call 循环存储了多条相同 assistant 回复
    const deduped: Message[] = []
    const seenAssistantContent = new Set<string>()
    for (const msg of raw) {
      if (msg.role === "assistant") {
        const text = typeof msg.content === "string" ? msg.content : ""
        // 跳过完全空的 assistant 消息
        if (!text) continue
        // 跳过已出现过的相同 assistant 内容（去重，仅对较长内容生效）
        if (text.length > 50 && seenAssistantContent.has(text)) continue
        if (text.length > 50) seenAssistantContent.add(text)
      }
      deduped.push(msg)
    }
    return deduped
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