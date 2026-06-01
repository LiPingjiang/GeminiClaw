// @ts-nocheck
// src/channels/qqbot/index.ts
// QQBotChannel: implements IChannel, supports websocket and webhook modes.
// Supports C2C, Group, and Interaction events.
import type { FastifyInstance } from "fastify";
import type { IChannel, ChannelContext } from "../types.js";
import type { Db } from "../../db/client.js";
import { messageText } from "../../providers/types.js";
import { registerWebhookRoute } from "./webhook.js";
import { QQBotWSClient, DEFAULT_INTENTS } from "./ws-client.js";
import type { MessageSource } from "./ws-client.js";
import { QQBotApi, parseInteractionEvent } from "./api.js";
import type { InteractionEvent, InlineKeyboard } from "./api.js";
import { sendC2CReply } from "./api.js";
import { dispatch } from "../../commands/dispatcher.js";
import { AgentRepository } from "../../agents/repository.js";
import { DispatcherAgent } from "../../guidance/dispatcher.js";
import { templateManager } from "../../templates/manager.js";
import { stripToolXml } from "../../utils/strip-tool-xml.js";

export interface QQBotChannelConfig {
  enabled: boolean;
  mode: "websocket" | "webhook";
  appId: string;
  clientSecret: string;
  /** webhook 模式：监听路径，默认 "/webhook/qqbot" */
  webhookPath?: string;
  /** websocket 模式：订阅 intents，默认 C2C + INTERACTION */
  intents?: number;
  /** 是否启用群聊，默认 true */
  groupEnabled?: boolean;
}

// Interaction callback registry (for approval workflows etc.)
type InteractionHandler = (event: InteractionEvent) => Promise<void>;
const interactionHandlers = new Map<string, InteractionHandler>();

/**
 * Register a handler for button interactions matching a prefix.
 * E.g. registerInteractionHandler("approve:", handler) matches button_data starting with "approve:"
 */
export function registerInteractionHandler(prefix: string, handler: InteractionHandler): void {
  interactionHandlers.set(prefix, handler);
}

export class QQBotChannel implements IChannel {
  private config: QQBotChannelConfig;
  private fastify?: FastifyInstance;
  private db?: Db;
  readonly name = "qqbot";
  private wsClient: QQBotWSClient | null = null;
  private api: QQBotApi | null = null;

  constructor(
    config: QQBotChannelConfig,
    fastify?: FastifyInstance,
    db?: Db,
  ) {
    this.config = config;
    this.fastify = fastify;
    this.db = db;
  }

  /** Get the QQBotApi instance (available after start) */
  getApi(): QQBotApi | null {
    return this.api;
  }

  async start(ctx: ChannelContext): Promise<void> {
    const { memory, agentLoop, config } = ctx;
    const { appId, clientSecret, mode } = this.config;

    this.api = new QQBotApi({ appId, clientSecret });

    const modelOverrides = new Map<string, string>();
    const startedAt = new Date();

    const dispatcher = this.db
      ? new DispatcherAgent({
          db: this.db,
          router: ctx.router,
          agentRepo: new AgentRepository(this.db),
          templateManager,
          model: config.agent.dispatcherModel,
        })
      : null;

    // -----------------------------------------------------------------------
    // Message handler (shared for C2C and Group)
    // -----------------------------------------------------------------------
    const handleMessage = async (
      source: MessageSource,
      content: string,
      _msgId: string,
    ): Promise<string> => {
      // Derive userId from source
      const userId = source.type === "c2c" ? source.openid : source.userOpenid;

      // ── 命令拦截 ──────────────────────────────────────────────────────────
      const cmdResult = await dispatch(content, {
        openid: userId,
        args: [],
        memory,
        config,
        modelOverrides,
        startedAt,
      });
      if (cmdResult !== null) {
        if (content.trimStart().startsWith("/new") && dispatcher) {
          dispatcher.clearUserSession(userId);
        }
        return cmdResult;
      }

      // ── Dispatcher 路由 ─────────────────────────────────────────────────
      let sessionId = userId;
      let agentName: string | null = null;
      let currentAgentId: string | null = null;
      if (dispatcher) {
        const routeResult = await dispatcher.route(content, userId);
        sessionId = routeResult.sessionId;
        agentName = routeResult.agentName;
        currentAgentId = routeResult.agentId;
        dispatcher.markBusy(routeResult.agentId);
      }

      // ── 正常 LLM 流程 ──────────────────────────────────────────────────
      await memory.ensureSession(sessionId);

      // Session 标题：首条消息时自动写入（截取前 24 字）
      if (this.db) {
        const row = this.db
          .prepare("SELECT title FROM chat_sessions WHERE id = ?")
          .get(sessionId) as { title: string | null } | undefined;
        if (!row?.title) {
          const title =
            content.length > 24 ? content.slice(0, 24) + "…" : content;
          this.db
            .prepare("UPDATE chat_sessions SET title = ? WHERE id = ?")
            .run(title, sessionId);
        }
      }

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

      const modelOverride = modelOverrides.get(userId);
      let finalReply = "";
      let _lastNonEmptyReply = "";

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
        toolContextExtra: {
          ...(this.db ? { db: this.db } : {}),
          userId,
          msgId: _msgId,
          appId,
          clientSecret,
        },
      })) {
        if (event.type === "message_delta") {
          finalReply += event.delta;
        } else if (event.type === "turn_start") {
          flushPendingTurn();
          if (finalReply) _lastNonEmptyReply = finalReply;
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

      // Mark agent as idle after processing
      if (dispatcher && currentAgentId) {
        dispatcher.markIdle(currentAgentId);
      }

      // 兜底：若最终轮为空，使用上一轮的有效回复
      if (!finalReply && _lastNonEmptyReply) finalReply = _lastNonEmptyReply;
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
      // Trace collection: record full trace data into evolution DB + notify engine
      if (ctx.evolution) {
        const toolSeq = pendingToolCalls.map((tc: any) => tc.function?.name ?? "unknown");
        const hadFail = turnMessages.some((m: any) => m.role === "tool" && m.content?.includes?.("Error"));
        setImmediate(() => {
          ctx.evolution!.getTraceCollector().record({
            sessionId,
            toolSequence: toolSeq,
            hadFailure: hadFail,
            messageCount: messagesToPersist.length,
            responseLength: finalReply.length,
          });
          ctx.evolution!.onTraceRecorded();
        });
      }
      return finalReply;
    };

    // -----------------------------------------------------------------------
    // Interaction handler
    // -----------------------------------------------------------------------
    const handleInteraction = async (event: InteractionEvent): Promise<void> => {
      // Route to registered handlers by prefix
      for (const [prefix, handler] of interactionHandlers) {
        if (event.buttonData.startsWith(prefix)) {
          await handler(event);
          return;
        }
      }
      console.log("[QQBotChannel] Unhandled interaction:", event.buttonData);
    };

    // -----------------------------------------------------------------------
    // Start mode
    // -----------------------------------------------------------------------
    if (mode === "websocket") {
      const intents = this.config.intents ?? DEFAULT_INTENTS;
      this.wsClient = new QQBotWSClient({
        appId,
        clientSecret,
        intents,
        onMessage: handleMessage,
        onInteraction: handleInteraction,
      });
      await this.wsClient.connect();
      // Expose the shared api instance from ws client
      this.api = this.wsClient.getApi();
      console.log("[QQBotChannel] WebSocket mode started (intents=0x%s)", intents.toString(16));
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
          const source: MessageSource = { type: "c2c", openid };
          const reply = await handleMessage(source, content, msgId);
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
