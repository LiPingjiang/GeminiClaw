// src/channels/qqbot/index.ts
// QQBotChannel: implements IChannel, supports websocket and webhook modes.

import type { FastifyInstance, FastifyPluginOptions } from "fastify"
import type { IChannel, ChannelContext } from "../types.js"
import type { ProviderRouter } from "../../providers/router.js"
import type { MemoryStrategy } from "../../memory/strategy.js"
import { registerWebhookRoute } from "./webhook.js"
import { QQBotWSClient } from "./ws-client.js"
import { sendC2CReply } from "./api.js"

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
    private fastify?: FastifyInstance
  ) {}

  async start(ctx: ChannelContext): Promise<void> {
    const { router, memory } = ctx
    const { appId, clientSecret, mode } = this.config

    /** 共用的消息处理逻辑 */
    const handleMessage = async (openid: string, content: string, msgId: string): Promise<string> => {
      await memory.ensureSession(openid)
      const convCtx = await memory.getContext(openid, content)
      const messages = [...convCtx.messages, { role: "user" as const, content }]
      const response = await router.chat(messages)
      await memory.appendTurn(
        openid,
        { role: "user", content },
        { role: "assistant", content: response.content }
      )
      return response.content
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
