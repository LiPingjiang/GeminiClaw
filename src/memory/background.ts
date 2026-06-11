// src/memory/background.ts
import type { Provider, Message } from "../providers/types.js"
import type { Db } from "../db/client.js"

interface BackgroundConfig {
  compactThresholdBytes: number
  maxActiveTopics: number
}

const SUMMARIZE_SYSTEM = `你是一个对话摘要助手。
给定一轮对话（用户消息 + 助手回复），用 2-3 句话概括核心内容。
只输出摘要文本，不要加标题或格式。`

const COMPACT_SYSTEM = `你是一个文档压缩助手。
给定一份事项文档（可能很长），将其压缩成原来 40% 左右的篇幅，保留所有关键信息，去除重复和冗余内容。
只输出压缩后的文档内容，不要加标题或说明。`

export class BackgroundService {
  private provider: Provider
  private db: Db
  private config: BackgroundConfig

  constructor(provider: Provider, db: Db, config: BackgroundConfig) {
    this.provider = provider
    this.db = db
    this.config = config
  }

  async summarize(userMsg: Message, assistantMsg: Message): Promise<string> {
    const msgs: Message[] = [
      { role: "system", content: SUMMARIZE_SYSTEM },
      { role: "user", content: `用户：${userMsg.content}\n助手：${assistantMsg.content}` },
    ]
    const resp = await this.provider.chat(msgs, { maxTokens: 256, temperature: 0 })
    return resp.content.trim()
  }

  async appendToTopic(topicId: string, content: string): Promise<void> {
    const topic = this.db.prepare(
      `SELECT doc_level2, doc_size FROM public_knowledge WHERE id = ?`
    ).get(topicId) as { doc_level2: string | null; doc_size: number } | undefined

    if (!topic) return

    const existing = topic.doc_level2 ?? ""
    const newContent = existing ? `${existing}\n\n${content}` : content
    const newSize = Buffer.byteLength(newContent, "utf8")

    if (newSize >= this.config.compactThresholdBytes) {
      // 触发 Compact：调摘要模型压缩
      const compacted = await this.compact(newContent)
      const compactedSize = Buffer.byteLength(compacted, "utf8")
      this.db.prepare(`
        UPDATE public_knowledge
        SET doc_level2 = ?, doc_size = ?, updated_at = datetime('now')
        WHERE id = ?
      `).run(compacted, compactedSize, topicId)
    } else {
      this.db.prepare(`
        UPDATE public_knowledge
        SET doc_level2 = ?, doc_size = ?, updated_at = datetime('now')
        WHERE id = ?
      `).run(newContent, newSize, topicId)
    }
  }

  private async compact(content: string): Promise<string> {
    const msgs: Message[] = [
      { role: "system", content: COMPACT_SYSTEM },
      { role: "user", content: content },
    ]
    const resp = await this.provider.chat(msgs, { maxTokens: 2048, temperature: 0 })
    return resp.content.trim()
  }

  async evictIfNeeded(): Promise<void> {
    const activeCount = (this.db.prepare(
      `SELECT COUNT(*) as cnt FROM public_knowledge WHERE active = 1`
    ).get() as { cnt: number }).cnt

    if (activeCount <= this.config.maxActiveTopics) return

    // 计算清理分数：时间权重 0.6 + 访问频率权重 0.3 + 大小权重 0.1
    // 分数越高越先清理（最不活跃）
    const toEvict = this.db.prepare(`
      SELECT id,
        (
          (julianday('now') - julianday(last_accessed_at)) / 90.0 * 0.6
          + (1.0 - CAST(access_count AS REAL) / MAX(access_count) OVER ()) * 0.3
          + (CAST(doc_size AS REAL) / 10240.0) * 0.1
        ) AS score
      FROM public_knowledge
      WHERE active = 1
      ORDER BY score DESC
      LIMIT ?
    `).all(activeCount - this.config.maxActiveTopics) as Array<{ id: string }>

    for (const { id } of toEvict) {
      this.db.prepare(`
        UPDATE public_knowledge SET active = 0, updated_at = datetime('now') WHERE id = ?
      `).run(id)
    }
  }

  /** 对话结束后调用，异步执行全部后台任务（不阻塞响应） */
  runAsync(
    topicId: string | null,
    userMsg: Message,
    assistantMsg: Message,
  ): void {
    // fire-and-forget，错误只记录不抛出
    Promise.resolve().then(async () => {
      try {
        const summary = await this.summarize(userMsg, assistantMsg)
        if (topicId) {
          await this.appendToTopic(topicId, summary)
        }
        await this.evictIfNeeded()
      } catch (err) {
        console.error("[BackgroundService] error:", err)
      }
    })
  }
}
