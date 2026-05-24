// src/memory/strategies/layered.ts
import { randomUUID } from "crypto"
import { stderr } from "process"
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
const SUMMARY_LARGE_THRESHOLD_CHARS = 3000

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

      // Warn if summary content is unusually large
      const summaryLen = (topic.summary ?? "").length
      if (summaryLen > SUMMARY_LARGE_THRESHOLD_CHARS) {
        stderr.write(
          `[layered] Warning: Memory topic "${topic.title}" (${topic.id}) has large summary content ` +
          `(${summaryLen} chars > threshold ${SUMMARY_LARGE_THRESHOLD_CHARS}). ` +
          `Consider summarizing or archiving to reduce memory retrieval overhead.\n`
        )
      }

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

    // 4. 构建永久区：Agent 自知 + 协作规则 + 其他 Agent 列表（每次从 DB 实时重建，永不压缩）
    const pinnedMessages = this._buildAgentEcosystemBlock(sessionId)

    // 5. 组装 context
    const messages = buildContext({
      systemPrompt: this.config.systemPrompt,
      pinnedMessages,
      activeTopics,
      topicDocs,
      recentHistory,
      userMessage,
      recentMessageLimit: this.config.recentMessageLimit,
    })

    return { messages, strategyName: this.name }
  }

  async appendMessages(sessionId: string, messages: Message[]): Promise<void> {
    await this.ensureSession(sessionId)

    const insertMsg = this.db.prepare(`
      INSERT INTO chat_messages (session_id, role, content, tool_calls, tool_call_id) VALUES (?, ?, ?, ?, ?)
    `)
    const insertAll = this.db.transaction(() => {
      for (const msg of messages) {
        const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)
        const toolCalls = msg.tool_calls ? JSON.stringify(msg.tool_calls) : null
        const toolCallId = msg.tool_call_id ?? null
        insertMsg.run(sessionId, msg.role, content, toolCalls, toolCallId)
      }
    })
    insertAll()

    this.db.prepare(`
      UPDATE chat_sessions SET message_count = message_count + ?, updated_at = datetime('now') WHERE id = ?
    `).run(messages.length, sessionId)

    // For triage: synthesize userMsg / assistantMsg from the batch
    const userMsg = messages.find(m => m.role === 'user')
    const assistantMsg = messages.filter(m => m.role === 'assistant').at(-1)
    if (userMsg && assistantMsg) {
      await this._runTriage(sessionId, userMsg, assistantMsg)
    }
  }

  async appendTurn(sessionId: string, userMsg: Message, assistantMsg: Message): Promise<void> {
    await this.ensureSession(sessionId)

    // 持久化消息
    this.db.prepare(`
      INSERT INTO chat_messages (session_id, role, content, tool_calls, tool_call_id) VALUES (?, ?, ?, ?, ?)
    `).run(sessionId, userMsg.role, typeof userMsg.content === 'string' ? userMsg.content : JSON.stringify(userMsg.content), null, null)
    this.db.prepare(`
      INSERT INTO chat_messages (session_id, role, content, tool_calls, tool_call_id) VALUES (?, ?, ?, ?, ?)
    `).run(sessionId, assistantMsg.role, typeof assistantMsg.content === 'string' ? assistantMsg.content : JSON.stringify(assistantMsg.content), assistantMsg.tool_calls ? JSON.stringify(assistantMsg.tool_calls) : null, null)

    // 更新 session 计数
    this.db.prepare(`
      UPDATE chat_sessions SET message_count = message_count + 2, updated_at = datetime('now') WHERE id = ?
    `).run(sessionId)

    await this._runTriage(sessionId, userMsg, assistantMsg)
  }

  /** 立项判断 + 后台处理（公共逻辑） */
  private async _runTriage(sessionId: string, userMsg: Message, assistantMsg: Message): Promise<void> {
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
    type Row = { role: string; content: string; tool_calls: string | null; tool_call_id: string | null }
    const rows = this.db.prepare(`
      SELECT role, content, tool_calls, tool_call_id FROM chat_messages
      WHERE session_id = ?
      ORDER BY id DESC LIMIT ?
    `).all(sessionId, this.config.recentMessageLimit) as Row[]
    return rows.map(row => {
      const msg: Message = { role: row.role as Message['role'], content: row.content }
      if (row.tool_calls) {
        try { msg.tool_calls = JSON.parse(row.tool_calls) } catch { /* ignore */ }
      }
      if (row.tool_call_id) msg.tool_call_id = row.tool_call_id
      return msg
    })
  }

  /**
   * 构建永久区：Agent 自知 + 协作规则 + 其他活跃 Agent 列表。
   * 每次从 DB 实时展开，永不被压缩。
   */
  private _buildAgentEcosystemBlock(sessionId: string): Message[] {
    type AgentRow = { agent_name: string; description: string | null; template_name: string; id: string }

    // 当前 session 对应的 Agent
    const self = this.db.prepare(
      `SELECT id, agent_name, description, template_name FROM agents
       WHERE session_id = ? AND depth = 0 AND status = 'active'
       ORDER BY created_at ASC LIMIT 1`
    ).get(sessionId) as AgentRow | undefined

    if (!self) return []

    // 其他活跃 Agent
    const others = this.db.prepare(
      `SELECT agent_name, description FROM agents
       WHERE status = 'active' AND depth = 0 AND id != ?
       ORDER BY created_at DESC`
    ).all(self.id) as Pick<AgentRow, 'agent_name' | 'description'>[]

    const othersList = others.length > 0
      ? others.map(a => `- **${a.agent_name}**：${a.description ?? '无描述'}`).join('\n')
      : '- （暂无其他 Agent）'

    const content = [
      `## 我是谁`,
      `我是 **${self.agent_name}**（模板：${self.template_name}\uff09。${self.description ?? ''}`,
      ``,
      `## 协作规则`,
      `处理每条消息前，先判断：`,
      `1. 这个需求在我的职责范围内吗？`,
      `2. 是否需要创建一个新的专要 Agent 来处理？`,
      `3. 是否已有其他 Agent 更适合？`,
      ``,
      `如果需要创建新 Agent，调用 \`create_agent\` 工具。不要强行处理超出自己职责的任务。`,
      ``,
      `## 当前活跃 Agents`,
      `- **${self.agent_name}**：${self.description ?? ''}  ← 这是我自己`,
      othersList,
    ].join('\n')

    return [{ role: 'system', content }]
  }
}
