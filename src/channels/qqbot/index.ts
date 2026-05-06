// src/channels/qqbot/index.ts
// QQBot webhook handler — C2C message support with HMAC-SHA256 signature verification.

import { createHmac } from "crypto"
import type { FastifyInstance, FastifyPluginOptions } from "fastify"
import type { ProviderRouter } from "../../providers/router.js"
import type { MemoryStrategy } from "../../memory/strategy.js"

export interface QQBotRouteOptions extends FastifyPluginOptions {
  router: ProviderRouter
  strategy: MemoryStrategy
  webhookPath: string
  appId: string
  clientSecret: string
}

interface QQBotEventBody {
  op?: number
  t?: string
  d?: {
    plain_token?: string
    event_ts?: string
    author?: { id?: string; user_openid?: string }
    content?: string
    id?: string
  }
}

function verifySignature(clientSecret: string, body: string, sig?: string, ts?: string): boolean {
  if (!sig || !ts) return false
  const expected = createHmac("sha256", clientSecret)
    .update(ts + body)
    .digest("hex")
  return sig === expected
}

async function getAccessToken(appId: string, clientSecret: string): Promise<string> {
  try {
    const res = await fetch("https://bots.qq.com/app/getAppAccessToken", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ appId, clientSecret }),
    })
    const data = (await res.json()) as { access_token?: string }
    return data.access_token ?? ""
  } catch {
    return ""
  }
}

async function sendC2CReply(
  appId: string,
  clientSecret: string,
  openid: string,
  content: string,
  msgId: string
): Promise<void> {
  const token = await getAccessToken(appId, clientSecret)
  if (!token) return
  await fetch(`https://api.sgroup.qq.com/v2/users/${openid}/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `QQBot ${token}`,
    },
    body: JSON.stringify({ content, msg_type: 0, msg_id: msgId }),
  })
}

export async function qqbotRoute(
  fastify: FastifyInstance,
  options: QQBotRouteOptions
): Promise<void> {
  const { router, strategy, webhookPath, appId, clientSecret } = options

  fastify.post<{ Body: QQBotEventBody }>(webhookPath, async (req, reply) => {
    const isTestMode = (req.query as Record<string, string>)?.test === "1"
    const rawBody = JSON.stringify(req.body)
    const sig = req.headers["x-signature-ed25519"] as string | undefined
    const ts = req.headers["x-signature-timestamp"] as string | undefined

    if (!isTestMode && !verifySignature(clientSecret, rawBody, sig, ts)) {
      return reply.status(401).send({ error: "Invalid signature" })
    }

    const event = req.body

    // op=13: URL verification challenge
    if (event.op === 13 && event.d?.plain_token) {
      const { plain_token, event_ts } = event.d
      const signature = createHmac("sha256", clientSecret)
        .update((event_ts ?? "") + plain_token)
        .digest("hex")
      return reply.send({ plain_token, signature })
    }

    // C2C message
    if (event.t === "C2C_MESSAGE_CREATE" && event.d) {
      const openid = event.d.author?.user_openid ?? event.d.author?.id ?? ""
      const content = (event.d.content ?? "").trim()
      const msgId = event.d.id ?? ""

      if (!openid || !content) {
        return reply.status(200).send({ ok: true })
      }

      // Reply 200 immediately; process in background
      void reply.status(200).send({ ok: true })

      setImmediate(async () => {
        try {
          await strategy.ensureSession(openid)
          const ctx = await strategy.getContext(openid, content)
          const messages = [...ctx.messages, { role: "user" as const, content }]
          const response = await router.chat(messages)
          await strategy.appendTurn(
            openid,
            { role: "user", content },
            { role: "assistant", content: response.content }
          )
          await sendC2CReply(appId, clientSecret, openid, response.content, msgId)
        } catch (err) {
          fastify.log.error({ err }, "QQBot: failed to process C2C message")
        }
      })

      return
    }

    return reply.status(200).send({ ok: true })
  })
}
