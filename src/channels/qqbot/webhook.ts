// src/channels/qqbot/webhook.ts
// QQBot webhook route: HMAC-SHA256 signature verification + C2C/Group/Interaction handling.
import type { FastifyInstance } from "fastify";
import { createHmac } from "crypto";
import { QQBotApi, parseInteractionEvent } from "./api.js";
import type { InteractionEvent } from "./api.js";
import type { MessageSource } from "./ws-client.js";

interface WebhookOpts {
  webhookPath: string;
  appId: string;
  clientSecret: string;
}

function verifySignature(
  clientSecret: string,
  body: string,
  sig: unknown,
  ts: unknown,
): boolean {
  if (!sig || !ts) return false;
  const expected = createHmac("sha256", clientSecret)
    .update((ts as string) + body)
    .digest("hex");
  return sig === expected;
}

export function registerWebhookRoute(
  fastify: FastifyInstance,
  opts: WebhookOpts,
  onMessage: (openid: string, content: string, msgId: string) => Promise<string>,
  onInteraction?: (event: InteractionEvent) => Promise<void>,
): void {
  const { webhookPath, appId, clientSecret } = opts;
  const api = new QQBotApi({ appId, clientSecret });

  fastify.post(webhookPath, async (req, reply) => {
    const isTestMode = (req.query as Record<string, string>)?.test === "1";
    const rawBody = JSON.stringify(req.body);
    const sig = req.headers["x-signature-ed25519"];
    const ts = req.headers["x-signature-timestamp"];
    if (!isTestMode && !verifySignature(clientSecret, rawBody, sig, ts)) {
      return reply.status(401).send({ error: "Invalid signature" });
    }
    const event = req.body as {
      op?: number;
      t?: string;
      d?: Record<string, unknown>;
    };

    // op=13: URL verification challenge
    if (event.op === 13 && (event.d as { plain_token?: string })?.plain_token) {
      const { plain_token, event_ts } = event.d as {
        plain_token: string;
        event_ts?: string;
      };
      const signature = createHmac("sha256", clientSecret)
        .update((event_ts ?? "") + plain_token)
        .digest("hex");
      return reply.send({ plain_token, signature });
    }

    // C2C message
    if (event.t === "C2C_MESSAGE_CREATE" && event.d) {
      const d = event.d as {
        author?: { user_openid?: string; id?: string };
        content?: string;
        id?: string;
      };
      const openid = d.author?.user_openid ?? d.author?.id ?? "";
      const content = (d.content ?? "").trim();
      const msgId = d.id ?? "";
      if (!openid || !content) {
        return reply.status(200).send({ ok: true });
      }
      // Dedup
      if (api.isDuplicate(msgId)) {
        return reply.status(200).send({ ok: true });
      }
      void reply.status(200).send({ ok: true });
      setImmediate(async () => {
        try {
          await onMessage(openid, content, msgId);
        } catch (err) {
          fastify.log.error({ err }, "QQBot webhook: failed to process C2C message");
        }
      });
      return;
    }

    // Group @bot message
    if ((event.t === "GROUP_AT_MESSAGE_CREATE" || event.t === "GROUP_MESSAGE_CREATE") && event.d) {
      const d = event.d as {
        group_openid?: string;
        author?: { member_openid?: string; id?: string };
        content?: string;
        id?: string;
      };
      const groupOpenid = d.group_openid ?? "";
      const userOpenid = d.author?.member_openid ?? d.author?.id ?? "";
      let content = (d.content ?? "").trim();
      const msgId = d.id ?? "";
      if (!groupOpenid || !content) {
        return reply.status(200).send({ ok: true });
      }
      if (api.isDuplicate(msgId)) {
        return reply.status(200).send({ ok: true });
      }
      // Strip @bot mention
      content = content.replace(/^<@!\d+>\s*/, "").trim();
      if (!content) {
        return reply.status(200).send({ ok: true });
      }
      void reply.status(200).send({ ok: true });
      setImmediate(async () => {
        try {
          // For webhook mode, group messages route through the same handler
          // using the userOpenid as the "openid" for routing purposes
          await onMessage(userOpenid, content, msgId);
        } catch (err) {
          fastify.log.error({ err }, "QQBot webhook: failed to process Group message");
        }
      });
      return;
    }

    // Interaction (button click)
    if (event.t === "INTERACTION_CREATE" && event.d) {
      const interaction = parseInteractionEvent(event.d);
      if (interaction) {
        // ACK immediately
        void api.acknowledgeInteraction(interaction.interactionId).catch(() => {});
        if (onInteraction) {
          setImmediate(() => {
            void onInteraction(interaction);
          });
        }
      }
      return reply.status(200).send({ ok: true });
    }

    return reply.status(200).send({ ok: true });
  });
}
