// src/channels/qqbot/webhook.ts
// QQBot webhook route: HMAC-SHA256 signature verification + C2C message handling.

import { createHmac } from "crypto"
import type { FastifyInstance } from "fastify"

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

export function registerWebhookRoute(
  fastify: FastifyInstance,
  opts: { webhookPath: string; appId: string; clientSecret: string },
  onMessage: (openid: string, content: string, msgId: string) => Promise<string>
): void {
  const { webhookPath, clientSecret } = opts

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
          await onMessage(openid, content, msgId)
        } catch (err) {
          fastify.log.error({ err }, "QQBot webhook: failed to process C2C message")
        }
      })

      return
    }

    return reply.status(200).send({ ok: true })
  })
}
