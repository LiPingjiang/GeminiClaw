// src/channels/qqbot/index.ts
// QQBotChannel: implements IChannel, supports websocket and webhook modes.

import type { FastifyInstance, FastifyPluginOptions } from "fastify"
import type { IChannel, ChannelContext } from "../types.js"
import type { ProviderRouter } from "../../providers/router.js"
import type { MemoryStrategy } from "../../memory/strategy.js"
import type { AgentLoop, InternalMessage } from "../../agent/index.js"
import { messageText } from "../../providers/types.js"
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
      const messages: InternalMessage[] = [
        ...convCtx.messages.flatMap((m): InternalMessage[] => {
          const text = typeof m.content === "string" ? m.content : messageText(m.content)
          if (m.role === "assistant") {
            return [{ role: "assistant", content: text }]
          }
          if (m.role === "user" || m.role === "system") {
            return [{ role: m.role, content: text }]
          }
          return []
        }),
        { role: "user" as const, content },
      ]

      // 用 AgentLoop 执行，收集 message_delta 拼接最终回复
      const modelOverride = modelOverrides.get(openid)
      let finalReply = ""
      for await (const event of agentLoop.run({
        messages,
        sessionId,
        ...(modelOverride ? { model: modelOverride } : {}),
        toolContextExtra: this.db ? { db: this.db, userId: openid } : {},
      })) {
        if (event.type === "message_delta") {
          finalReply += event.delta
        }
      }

      if (!finalReply) finalReply = "（无回复）"

      // 注入 Agent 名称（markdown 加粗，单独一行）
      if (agentName) {
        finalReply = `**${agentName}**\n\n${finalReply}`
      }

      await memory.appendTurn(
        sessionId,
        { role: "user", content },
        { role: "assistant", content: finalReply }
      )
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
