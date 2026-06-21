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
import { logger as persistentLogger } from "../../utils/logger.js"

interface LayeredStrategyConfig {
  db: Db
  routerProvider: Provider
  triageProvider: Provider
  systemPrompt: string
  recentMessageLimit: number
  contextTokenBudget: number
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
      persistentLogger.info("layered-memory", "session_created", { sessionId })
    } else {
      const stats = this.db.prepare(`SELECT message_count FROM chat_sessions WHERE id = ?`).get(sessionId) as { message_count: number } | undefined
      persistentLogger.debug("layered-memory", "session_reused", { sessionId, messageCount: stats?.message_count ?? 0 })
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

    // Audit log: memory context retrieval
    persistentLogger.debug("layered-memory", "get_context", {
      sessionId,
      agentId: agentId ?? null,
      activeTopicsCount: activeTopics.length,
      matchedTopics: routeResult.matches.map(m => ({ topicId: m.topicId, confidence: m.confidence, level: m.level })),
      topicDocsLoaded: topicDocs.map(d => ({ title: d.title, level: d.level, contentLen: d.content.length })),
      recentHistoryCount: recentHistory.length,
      recentMessageLimit: this.config.recentMessageLimit,
      workspaceMemChars: workspaceMem.length,
      finalMessageCount: messages.length,
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

  // Token-budget dynamic loading: load messages from newest to oldest,
  // stopping when we hit the token budget. Replaces the old fixed LIMIT 40.
  //
  // For the 2 most recent user requests: keep full tool chains
  // For older requests: compress to user + summary + final_reply

  private estimateTokens(text: string): number {
    if (!text) return 0
    return Math.ceil((text.length / 4) * 1.2)
  }

  private getRecentHistory(sessionId: string): Message[] {
    const TOKEN_BUDGET = this.config.contextTokenBudget ?? 120_000
    const KEEP_FULL_REQUESTS = 2

    // Load a large batch of messages (up to 600)
    const raw = this.db.prepare(`
      SELECT role, content, tool_calls, tool_call_id FROM chat_messages
      WHERE session_id = ?
      ORDER BY id DESC LIMIT 600
    `).all(sessionId) as Array<{
      role: string; content: string; tool_calls: string | null; tool_call_id: string | null
    }>

    if (raw.length === 0) return []

    // Reverse to chronological order (oldest first)
    raw.reverse()

    // Segment into request groups (user msg + following assistant/tool msgs)
    interface RequestGroup {
      userMsg: typeof raw[0] | null
      messages: typeof raw
      totalTokens: number
    }

    const groups: RequestGroup[] = []
    let currentGroup: RequestGroup = { userMsg: null, messages: [], totalTokens: 0 }

    for (const row of raw) {
      if (row.role === "user") {
        if (currentGroup.messages.length > 0) {
          groups.push(currentGroup)
        }
        currentGroup = { userMsg: row, messages: [row], totalTokens: this.estimateTokens(row.content) }
      } else {
        currentGroup.messages.push(row)
        const extra = row.tool_calls ? row.tool_calls.length : 0
        currentGroup.totalTokens += this.estimateTokens((row.content ?? "") + (extra > 0 ? row.tool_calls! : ""))
      }
    }
    if (currentGroup.messages.length > 0) {
      groups.push(currentGroup)
    }

    // Build output: walk from newest group to oldest with token budget
    const finalResult: Message[] = []
    let budget = TOKEN_BUDGET
    let recentKept = 0

    for (let i = groups.length - 1; i >= 0; i--) {
      const group = groups[i]

      if (recentKept < KEEP_FULL_REQUESTS) {
        // Keep full tool chain for recent requests
        if (group.totalTokens > budget) break
        budget -= group.totalTokens
        const msgs = this.buildMessagesFromRaw(group.messages)
        finalResult.unshift(...msgs)
        recentKept++
      } else {
        // Compress older requests
        const compressed = this.compressRequestGroup(group)
        const tokens = compressed.reduce(
          (sum, m) => sum + this.estimateTokens(typeof m.content === "string" ? m.content : ""),
          0
        )
        if (tokens > budget) break
        budget -= tokens
        finalResult.unshift(...compressed)
      }
    }

    persistentLogger.debug("layered-memory", "token_budget_loading", {
      sessionId,
      totalRawMessages: raw.length,
      requestGroups: groups.length,
      fullRequestsKept: recentKept,
      usedTokens: TOKEN_BUDGET - budget,
      tokenBudget: TOKEN_BUDGET,
      finalMessageCount: finalResult.length,
    })

    return finalResult
  }

  private buildMessagesFromRaw(raw: Array<{
    role: string; content: string; tool_calls: string | null; tool_call_id: string | null
  }>): Message[] {
    const messages: Message[] = []
    const seenAssistantContent = new Set<string>()

    for (const row of raw) {
      if (row.role === "assistant") {
        const text = row.content ?? ""
        if (!text && !row.tool_calls) continue
        if (text.length > 50 && seenAssistantContent.has(text) && !row.tool_calls) continue
        if (text.length > 50 && !row.tool_calls) seenAssistantContent.add(text)

        const msg: Message = { role: "assistant", content: text }
        if (row.tool_calls) {
          try { msg.tool_calls = JSON.parse(row.tool_calls) } catch { /* ignore */ }
        }
        messages.push(msg)
      } else if (row.role === "tool") {
        if (row.tool_call_id) {
          messages.push({ role: "tool", content: row.content ?? "", tool_call_id: row.tool_call_id })
        }
      } else if (row.role === "user" || row.role === "system") {
        messages.push({ role: row.role, content: row.content ?? "" })
      }
    }
    return messages
  }

  private compressRequestGroup(group: {
    userMsg: { role: string; content: string; tool_calls: string | null; tool_call_id: string | null } | null
    messages: Array<{ role: string; content: string; tool_calls: string | null; tool_call_id: string | null }>
  }): Message[] {
    const result: Message[] = []

    // User message (always keep)
    if (group.userMsg) {
      result.push({ role: "user", content: group.userMsg.content ?? "" })
    }

    // Find the final assistant reply (last assistant without tool_calls)
    let finalReply = ""
    const toolNames: string[] = []
    let toolCallCount = 0

    for (let i = group.messages.length - 1; i >= 0; i--) {
      const msg = group.messages[i]
      if (msg.role === "assistant" && !msg.tool_calls && msg.content && msg.content.length > 10) {
        finalReply = msg.content
        break
      }
    }

    // Collect tool names used
    for (const msg of group.messages) {
      if (msg.role === "assistant" && msg.tool_calls) {
        toolCallCount++
        try {
          const calls = JSON.parse(msg.tool_calls)
          for (const tc of calls) {
            if (tc.name && !toolNames.includes(tc.name)) toolNames.push(tc.name)
          }
        } catch { /* ignore */ }
      }
    }

    // Build compressed summary
    if (toolCallCount > 0) {
      const summary = "[" + toolCallCount + " tool calls: " + toolNames.slice(0, 5).join(", ") + (toolNames.length > 5 ? "..." : "") + "]"
      result.push({ role: "assistant", content: summary })
    }

    // Final reply (truncated if too long)
    if (finalReply) {
      const truncated = finalReply.length > 800
        ? finalReply.slice(0, 600) + "\n...[truncated]"
        : finalReply
      result.push({ role: "assistant", content: truncated })
    }

    return result
  }

  async appendMessages(sessionId: string, messages: Message[]): Promise<void> {
    await this.ensureSession(sessionId)
    const insert = this.db.prepare(
      `INSERT INTO chat_messages (session_id, role, content, tool_calls, tool_call_id) VALUES (?, ?, ?, ?, ?)`
    )
    for (const msg of messages) {
      const toolCallsJson = msg.tool_calls ? JSON.stringify(msg.tool_calls) : null
      const toolCallId = msg.tool_call_id ?? null
      insert.run(sessionId, msg.role, msg.content, toolCallsJson, toolCallId)
    }
    this.db.prepare(
      `UPDATE chat_sessions SET message_count = message_count + ?, updated_at = datetime('now') WHERE id = ?`
    ).run(messages.length, sessionId)
  }
}