// @ts-nocheck
// src/channels/qqbot/index.ts
// QQBotChannel: implements IChannel, supports websocket and webhook modes.
import type { FastifyInstance, FastifyPluginOptions } from "fastify";
import type { IChannel, ChannelContext } from "../types.js";
import type { ProviderRouter } from "../../providers/router.js";
import type { MemoryStrategy } from "../../memory/strategy.js";
import type { Db } from "../../db/client.js";
import { messageText } from "../../providers/types.js";
import { registerWebhookRoute } from "./webhook.js";
import { QQBotWSClient } from "./ws-client.js";
import { sendC2CReply } from "./api.js";
import { dispatch } from "../../commands/dispatcher.js";
import { AgentRepository } from "../../agents/repository.js";
import { GuidanceLayer } from "../../guidance/layer.js";
import { templateManager } from "../../templates/manager.js";
import { stripToolXml } from "../../utils/strip-tool-xml.js";

export interface QQBotChannelConfig {
  enabled: boolean;
  mode: "websocket" | "webhook";
  appId: string;
  clientSecret: string;
  /** webhook 模式：监听路径，默认 "/webhook/qqbot" */
  webhookPath?: string;
  /** websocket 模式：订阅 intents，默认 1073741824 (C2C 消息) */
  intents?: number;
}

export class QQBotChannel implements IChannel {
  private config: QQBotChannelConfig;
  private fastify?: FastifyInstance;
  private db?: Db;
  readonly name = "qqbot";
  private wsClient: QQBotWSClient | null = null;

  constructor(
    config: QQBotChannelConfig,
    fastify?: FastifyInstance,
    db?: Db,
  ) {
    this.config = config;
    this.fastify = fastify;
    this.db = db;
  }

  async start(ctx: ChannelContext): Promise<void> {
    const { memory, agentLoop, config } = ctx;
    const { appId, clientSecret, mode } = this.config;

    const modelOverrides = new Map<string, string>();
    const startedAt = new Date();

    const guidanceLayer = this.db
      ? new GuidanceLayer(
          new AgentRepository(this.db),
          templateManager,
          this.db,
        )
      : null;

    const handleMessage = async (
      openid: string,
      content: string,
      _msgId: string,
    ): Promise<string> => {
      // ── 命令拦截 ──────────────────────────────────────────────────────────
      const cmdResult = await dispatch(content, {
        openid,
        args: [],
        memory,
        config,
        modelOverrides,
        startedAt,
      });
      if (cmdResult !== null) {
        if (content.trimStart().startsWith("/new") && guidanceLayer) {
          guidanceLayer.clearUserSession(openid);
        }
        return cmdResult;
      }

      // ── 引导层路由 ──────────────────────────────────────────────────────
      let sessionId = openid;
      let agentName: string | null = null;
      if (guidanceLayer) {
        const routeResult = await guidanceLayer.route(content, openid);
        sessionId = routeResult.sessionId;
        agentName = routeResult.agentName;
      }

      // ── 正常 LLM 流程 ──────────────────────────────────────────────────
      await memory.ensureSession(sessionId);
      const convCtx = await memory.getContext(sessionId, content);

      const messages = [
        ...convCtx.messages.flatMap((m) => {
          const text =
            typeof m.content === "string"
              ? m.content
              : messageText(m.content);
          if (m.role === "assistant") {
            const toolCalls =
              m.tool_calls && m.tool_calls.length > 0
                ? m.tool_calls.map((tc: {
                    id: string;
                    function: { name: string; arguments: string };
                  }) => ({
                    id: tc.id,
                    name: tc.function.name,
                    args: (() => {
                      try {
                        return JSON.parse(tc.function.arguments);
                      } catch {
                        return {};
                      }
                    })(),
                  }))
                : undefined;
            const msg = toolCalls
              ? { role: "assistant" as const, content: text, tool_calls: toolCalls }
              : { role: "assistant" as const, content: text };
            return [msg];
          }
          if (m.role === "tool") {
            return [
              {
                role: "tool" as const,
                tool_call_id: (m as { tool_call_id?: string }).tool_call_id ?? "",
                content: typeof m.content === "string" ? m.content : "",
              },
            ];
          }
          if (m.role === "user" || m.role === "system") {
            return [{ role: m.role as "user" | "system", content: text }];
          }
          return [];
        }),
        { role: "user" as const, content },
      ];

      const modelOverride = modelOverrides.get(openid);
      let finalReply = "";

      const turnMessages: Array<Record<string, unknown>> = [];
      let pendingAssistant: Record<string, unknown> | null = null;
      const pendingToolCalls: Array<Record<string, unknown>> = [];
      const pendingToolResults: Array<Record<string, unknown>> = [];

      const flushPendingTurn = () => {
        if (pendingAssistant) {
          const assistantMsg =
            pendingToolCalls.length > 0
              ? { ...pendingAssistant, tool_calls: [...pendingToolCalls] }
              : pendingAssistant;
          turnMessages.push(assistantMsg);
          pendingToolCalls.splice(0);
          pendingAssistant = null;
        }
        turnMessages.push(...pendingToolResults.splice(0));
      };

      for await (const event of agentLoop.run({
        messages,
        sessionId,
        ...(modelOverride ? { model: modelOverride } : {}),
        toolContextExtra: this.db ? { db: this.db, userId: openid } : {},
      })) {
        if (event.type === "message_delta") {
          finalReply += event.delta;
        } else if (event.type === "turn_start") {
          flushPendingTurn();
          finalReply = "";
        } else if (event.type === "turn_end") {
          pendingAssistant = { ...event.message };
        } else if (event.type === "tool_start") {
          pendingToolCalls.push({
            id: event.toolCallId,
            type: "function",
            function: {
              name: event.toolName,
              arguments: JSON.stringify(event.args),
            },
          });
        } else if (event.type === "tool_end") {
          pendingToolResults.push({
            role: "tool",
            content: event.result.content,
            tool_call_id: event.toolCallId,
          });
        }
      }
      flushPendingTurn();

      if (!finalReply) finalReply = "（无回复）";
      finalReply = stripToolXml(finalReply);

      if (agentName) {
        finalReply = `**${agentName}**\n\n${finalReply}`;
      }

      const userMsg = { role: "user" as const, content };
      const messagesToPersist: Array<Record<string, unknown>> = [userMsg];
      if (turnMessages.length > 0) {
        const lastIdx = turnMessages.length - 1;
        const last = turnMessages[lastIdx];
        if (last.role === "assistant") {
          turnMessages[lastIdx] = { ...last, content: finalReply };
        }
        messagesToPersist.push(...turnMessages);
      } else {
        messagesToPersist.push({ role: "assistant", content: finalReply });
      }
      await memory.appendMessages(
        sessionId,
        messagesToPersist as Parameters<typeof memory.appendMessages>[1],
      );
      return finalReply;
    };

    if (mode === "websocket") {
      this.wsClient = new QQBotWSClient({
        appId,
        clientSecret,
        intents: this.config.intents ?? 1073741824,
        onMessage: handleMessage,
      });
      await this.wsClient.connect();
      console.log("[QQBotChannel] WebSocket mode started");
    } else {
      if (!this.fastify) {
        throw new Error(
          "[QQBotChannel] fastify instance is required for webhook mode",
        );
      }
      const webhookPath = this.config.webhookPath ?? "/webhook/qqbot";
      registerWebhookRoute(
        this.fastify,
        { webhookPath, appId, clientSecret },
        async (openid, content, msgId) => {
          const reply = await handleMessage(openid, content, msgId);
          await sendC2CReply(appId, clientSecret, openid, reply, msgId);
          return reply;
        },
      );
      console.log(`[QQBotChannel] Webhook mode registered at ${webhookPath}`);
    }
  }

  async stop(): Promise<void> {
    if (this.wsClient) {
      this.wsClient.disconnect();
      this.wsClient = null;
    }
  }
}

export interface QQBotRouteOptions extends FastifyPluginOptions {
  router: ProviderRouter;
  strategy: MemoryStrategy;
  webhookPath: string;
  appId: string;
  clientSecret: string;
}

export async function qqbotRoute(
  fastify: FastifyInstance,
  options: QQBotRouteOptions,
): Promise<void> {
  const { router, strategy, webhookPath, appId, clientSecret } = options;
  registerWebhookRoute(
    fastify,
    { webhookPath, appId, clientSecret },
    async (openid, content, msgId) => {
      await strategy.ensureSession(openid);
      const ctx = await strategy.getContext(openid, content);
      const messages = [...ctx.messages, { role: "user" as const, content }];
      const response = await router.chat(messages);
      await memory_appendTurn(strategy, openid, content, response.content);
      await sendC2CReply(appId, clientSecret, openid, response.content, msgId);
      return response.content;
    },
  );
}

async function memory_appendTurn(
  strategy: MemoryStrategy,
  openid: string,
  userContent: string,
  assistantContent: string,
): Promise<void> {
  await strategy.appendTurn(
    openid,
    { role: "user", content: userContent },
    { role: "assistant", content: assistantContent },
  );
}
