// src/channels/qqbot/index.ts
// QQBotChannel: implements IChannel, supports websocket and webhook modes.

import type { FastifyInstance, FastifyPluginOptions } from "fastify"
import type { IChannel, ChannelContext } from "../types.js"
import type { ProviderRouter } from "../../providers/router.js"
import type { MemoryStrategy } from "../../memory/strategy.js"
import type { AgentLoop, InternalMessage } from "../../agent/index.js"
import { messageText } from "../../providers/types.js"
import type { Message as ProviderMessage, ToolCall as ProviderToolCall } from "../../providers/types.js"
import { registerWebhookRoute } from "./webhook.js"
import { QQBotWSClient } from "./ws-client.js"
import { sendC2CReply } from "./api.js"
import { dispatch } from "../../commands/dispatcher.js"
import type { Db } from "../../db/client.js"
import { AgentRepository } from "../../agents/repository.js"
import { GuidanceLayer } from "../../guidance/layer.js"
import { templateManager } from "../../templates/manager.js"

export interface QQBotChannelConfig {
  enabled: boolean
  mode: "websocket" | "webhook"
  appId: string
  clientSecret: string
  /** webhook 模式：监听路径，默认 "/webhook/qqbot" */
  webhookPath?: string
  /** websocket 模式：订阅 intents，默认 1073741824 (C2C 消息) */
  intents?: number
}

export class QQBotChannel implements IChannel {
  readonly name = "qqbot"

  private wsClient: QQBotWSClient | null = null

  constructor(
    private config: QQBotChannelConfig,
    private fastify?: FastifyInstance,
    private db?: Db
  ) {}

  async start(ctx: ChannelContext): Promise<void> {
    const { memory, agentLoop, config } = ctx
    const { appId, clientSecret, mode } = this.config

    // Per-session model overrides: openid → "provider/model"
    const modelOverrides = new Map<string, string>()
    const startedAt = new Date()

    // Build GuidanceLayer if db is available
    const guidanceLayer: GuidanceLayer | null = this.db
      ? new GuidanceLayer(new AgentRepository(this.db), templateManager, this.db)
      : null

    /** 共用的消息处理逻辑：通过 AgentLoop 执行，支持 tool calls */
    const handleMessage = async (openid: string, content: string, _msgId: string): Promise<string> => {
      // ── 命令拦截（优先于 LLM）──────────────────────────────────────────────
      const cmdResult = await dispatch(content, {
        openid,
        args: [],           // parsed inside dispatch
        memory,
        config,
        modelOverrides,
        startedAt,
      })
      if (cmdResult !== null) {
        // /new resets the session — clear sticky so next message starts fresh
        if (content.trimStart().startsWith("/new") && guidanceLayer) {
          guidanceLayer.clearUserSession(openid)
        }
        return cmdResult
      }

      // ── 引导层路由 ──────────────────────────────────────────────────────────
      let sessionId = openid
      let agentName: string | null = null

      if (guidanceLayer) {
        const routeResult = await guidanceLayer.route(content, openid)
        sessionId = routeResult.sessionId
        agentName = routeResult.agentName
      }

      // ── 正常 LLM 流程 ──────────────────────────────────────────────────────
      await memory.ensureSession(sessionId)
      const convCtx = await memory.getContext(sessionId, content)

      // 构建完整的 InternalMessage 历史 + 新消息
      // Bug 2 fix: preserve tool/assistant-with-tool_calls messages
      const messages: InternalMessage[] = [
        ...convCtx.messages.flatMap((m): InternalMessage[] => {
          const text = typeof m.content === "string" ? m.content : messageText(m.content)
          if (m.role === "assistant") {
            // Convert provider (OpenAI) format tool_calls → agent internal format
            const toolCalls = m.tool_calls && m.tool_calls.length > 0
              ? m.tool_calls.map((tc) => ({
                  id: tc.id,
                  name: tc.function.name,
                  args: (() => { try { return JSON.parse(tc.function.arguments) } catch { return {} } })()
                }))
              : undefined
            const msg = toolCalls
              ? { role: "assistant" as const, content: text, tool_calls: toolCalls }
              : { role: "assistant" as const, content: text }
            return [msg as InternalMessage]
          }
          if (m.role === "tool") {
            const toolMsg: InternalMessage = { role: "tool", tool_call_id: m.tool_call_id ?? "", content: typeof m.content === "string" ? m.content : "" }
            return [toolMsg]
          }
          if (m.role === "user" || m.role === "system") {
            return [{ role: m.role, content: text }]
          }
          return []
        }),
        { role: "user" as const, content },
      ]

      // 用 AgentLoop 执行，收集所有事件以便完整持久化
      const modelOverride = modelOverrides.get(openid)
      let finalReply = ""

      // 收集完整的消息序列（含 tool calls / results）
      // 事件顺序：turn_end → tool_start×N → tool_end×N → turn_start → ...
      // 因此在 turn_end 时暂存 pendingAssistant，等收完 tool_start 后再 push
      const turnMessages: ProviderMessage[] = []
      let pendingAssistant: ProviderMessage | null = null
      const pendingToolCalls: ProviderToolCall[] = []
      const pendingToolResults: ProviderMessage[] = []

      const flushPendingTurn = () => {
        if (pendingAssistant) {
          const assistantMsg: ProviderMessage = pendingToolCalls.length > 0
            ? { ...pendingAssistant, tool_calls: [...pendingToolCalls] }
            : pendingAssistant
          turnMessages.push(assistantMsg)
          pendingToolCalls.splice(0)
          pendingAssistant = null
        }
        turnMessages.push(...pendingToolResults.splice(0))
      }

      for await (const event of agentLoop.run({
        messages,
        sessionId,
        ...(modelOverride ? { model: modelOverride } : {}),
        toolContextExtra: this.db ? { db: this.db, userId: openid } : {},
      })) {
        if (event.type === "message_delta") {
          finalReply += event.delta
        } else if (event.type === "turn_start") {
          // 新 turn 开始前，把上一 turn 的 pending 数据 flush
          flushPendingTurn()
        } else if (event.type === "turn_end") {
          // 暂存 assistant 消息；tool_start 事件会在此之后到来以补充 tool_calls
          pendingAssistant = { ...event.message }
        } else if (event.type === "tool_start") {
          // 收集 tool call（从 agent 内部格式转换为 provider OpenAI 格式）
          pendingToolCalls.push({
            id: event.toolCallId,
            type: "function",
            function: { name: event.toolName, arguments: JSON.stringify(event.args) },
          })
        } else if (event.type === "tool_end") {
          // 收集工具执行结果
          pendingToolResults.push({
            role: "tool",
            content: event.result.content,
            tool_call_id: event.toolCallId,
          })
        }
      }
      // 循环结束后 flush 最后一轮
      flushPendingTurn()

      if (!finalReply) finalReply = "（无回复）"

      // 注入 Agent 名称（markdown 加粗，单独一行）
      if (agentName) {
        finalReply = `**${agentName}**\n\n${finalReply}`
      }

      // 持久化完整消息序列（user + 所有 turn 的 assistant/tool 消息）
      // turnMessages 里最后一条 assistant 消息就是最终回复，确保 content 正确
      const userMsg: ProviderMessage = { role: "user", content }
      const messagesToPersist: ProviderMessage[] = [userMsg]

      if (turnMessages.length > 0) {
        // 将最后一条 assistant 消息的 content 更新为含 agentName 前缀的 finalReply
        const lastIdx = turnMessages.length - 1
        const last = turnMessages[lastIdx]
        if (last.role === "assistant") {
          turnMessages[lastIdx] = { ...last, content: finalReply }
        }
        messagesToPersist.push(...turnMessages)
      } else {
        // AgentLoop 没有产出任何 turn_end（极少数情况），退化为兼容路径
        messagesToPersist.push({ role: "assistant", content: finalReply })
      }

      await memory.appendMessages(sessionId, messagesToPersist)
      return finalReply
    }

    if (mode === "websocket") {
      this.wsClient = new QQBotWSClient({
        appId,
        clientSecret,
        intents: this.config.intents ?? 1073741824,
        onMessage: handleMessage,
      })
      await this.wsClient.connect()
      console.log("[QQBotChannel] WebSocket mode started")
    } else {
      // webhook mode
      if (!this.fastify) {
        throw new Error("[QQBotChannel] fastify instance is required for webhook mode")
      }
      const webhookPath = this.config.webhookPath ?? "/webhook/qqbot"
      registerWebhookRoute(
        this.fastify,
        { webhookPath, appId, clientSecret },
        async (openid, content, msgId) => {
          const reply = await handleMessage(openid, content, msgId)
          await sendC2CReply(appId, clientSecret, openid, reply, msgId)
          return reply
        }
      )
      console.log(`[QQBotChannel] Webhook mode registered at ${webhookPath}`)
    }
  }

  async stop(): Promise<void> {
    if (this.wsClient) {
      this.wsClient.disconnect()
      this.wsClient = null
    }
  }
}

// ── Legacy Fastify plugin (backward-compat) ─────────────────────────────────
// Keeps the original qqbotRoute API so existing tests/server code continue to
// compile without changes.

export interface QQBotRouteOptions extends FastifyPluginOptions {
  router: ProviderRouter
  strategy: MemoryStrategy
  webhookPath: string
  appId: string
  clientSecret: string
}

export async function qqbotRoute(
  fastify: FastifyInstance,
  options: QQBotRouteOptions
): Promise<void> {
  const { router, strategy, webhookPath, appId, clientSecret } = options

  registerWebhookRoute(
    fastify,
    { webhookPath, appId, clientSecret },
    async (openid, content, msgId) => {
      await strategy.ensureSession(openid)
      const ctx = await strategy.getContext(openid, content)
      const messages = [...ctx.messages, { role: "user" as const, content }]
      const response = await router.chat(messages)
      await memory_appendTurn(strategy, openid, content, response.content)
      await sendC2CReply(appId, clientSecret, openid, response.content, msgId)
      return response.content
    }
  )
}

async function memory_appendTurn(
  strategy: MemoryStrategy,
  openid: string,
  userContent: string,
  assistantContent: string
): Promise<void> {
  await strategy.appendTurn(
    openid,
    { role: "user", content: userContent },
    { role: "assistant", content: assistantContent }
  )
}
