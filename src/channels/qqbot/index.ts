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
import { sendC2CReply, buildBusyKeyboard } from "./api.js";
import { dispatch } from "../../commands/dispatcher.js";
import { AgentRepository } from "../../agents/repository.js";
import { AgentGate } from "../../guidance/agent-gate.js";
import type { GateResult } from "../../guidance/agent-gate.js";
import { stripToolXml } from "../../utils/strip-tool-xml.js";
import { randomUUID } from "node:crypto";

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

    const gate = this.db
      ? new AgentGate({
          db: this.db,
          agentRepo: new AgentRepository(this.db),
          maxAgents: config.agent.maxAgents ?? 5,
        })
      : null;

    // Pending busy prompts: requestId -> { userId, message, msgId, source }
    const pendingBusy = new Map<string, {
      userId: string;
      message: string;
      msgId: string;
      source: MessageSource;
    }>();

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
        if (content.trimStart().startsWith("/new") && gate) {
          gate.clearUserSession(userId);
        }
        return cmdResult;
      }

      // ── AgentGate: busy 检测 ────────────────────────────────────────────
      let sessionId = userId;
      let currentAgentId: string | null = null;
      if (gate) {
        // Check if user's agent is busy
        const busyInfo = gate.checkBusy(userId);
        if (busyInfo) {
          // Agent is busy — send keyboard prompt and return early
          const requestId = randomUUID().slice(0, 8);
          pendingBusy.set(requestId, {
            userId,
            message: content,
            msgId: _msgId,
            source,
          });
          const keyboard = buildBusyKeyboard(requestId);
          const prompt = `⏳ 助手正在忙：**${busyInfo.currentWork}**\n\n你可以选择等待当前任务完成，或者新建一个助手来处理。`;
          if (this.api) {
            const target = source.type === "c2c"
              ? { type: "c2c" as const, openid: source.openid }
              : { type: "group" as const, groupOpenid: (source as any).groupOpenid };
            await this.api.sendReply(target, prompt, _msgId, keyboard);
          }
          return prompt;
        }

        // Agent is idle — proceed
        const gateResult = await gate.getOrCreateAgent(userId);
        sessionId = gateResult.sessionId;
        currentAgentId = gateResult.agentId;
        gate.markBusy(gateResult.agentId, content.slice(0, 30));
      }

      // ── Delegate to processWithAgent ──────────────────────────────────
      const reply = await processWithAgent(sessionId, currentAgentId, content, _msgId, userId);
      // Mark agent as idle after processing
      if (gate && currentAgentId) {
        gate.markIdle(currentAgentId);
      }
      return reply;
    };

    // -----------------------------------------------------------------------
    // Core LLM processing (shared by handleMessage and interaction handler)
    // -----------------------------------------------------------------------
    const processWithAgent = async (
      sessionId: string,
      agentId: string | null,
      content: string,
      msgId: string,
      userId: string,
    ): Promise<string> => {
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
          msgId,
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

      // 兜底：若最终轮为空，使用上一轮的有效回复
      if (!finalReply && _lastNonEmptyReply) finalReply = _lastNonEmptyReply;
      if (!finalReply) finalReply = "（无回复）";
      finalReply = stripToolXml(finalReply);

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
      // Notify twin-system activity tracker (for idle detection)
      if (ctx.twinSystem) {
        ctx.twinSystem.activityTracker.recordActivity();
      }
      return finalReply;
    };

    // -----------------------------------------------------------------------
    // Busy-choice interaction handler
    // -----------------------------------------------------------------------
    registerInteractionHandler("busy:", async (event: InteractionEvent) => {
      // Parse: "busy:{requestId}:{choice}" where choice = "queue" | "new"
      const parts = event.buttonData.split(":");
      if (parts.length < 3) return;
      const requestId = parts[1];
      const choice = parts[2]; // "queue" or "new"

      const pending = pendingBusy.get(requestId);
      if (!pending) {
        console.warn("[QQBotChannel] busy interaction for unknown requestId:", requestId);
        return;
      }
      pendingBusy.delete(requestId);

      if (choice === "queue" && gate) {
        // Queue the message — will be processed when agent becomes idle
        // Send acknowledgement
        if (this.api) {
          const target = pending.source.type === "c2c"
            ? { type: "c2c" as const, openid: (pending.source as any).openid }
            : { type: "group" as const, groupOpenid: (pending.source as any).groupOpenid };
          await this.api.sendActive(target, "✅ 已加入队列，助手完成当前任务后会立即处理你的消息。");
        }

        // Actually queue — when agent idle, gate.markIdle triggers drain
        const gateResult = await gate.queueForAgent(pending.userId, pending.message);
        // Now agent is idle, process the message
        gate.markBusy(gateResult.agentId, pending.message.slice(0, 30));
        const reply = await processWithAgent(
          gateResult.sessionId, gateResult.agentId,
          pending.message, pending.msgId, pending.userId,
        );
        gate.markIdle(gateResult.agentId);
        // Send the reply
        if (this.api) {
          const target = pending.source.type === "c2c"
            ? { type: "c2c" as const, openid: (pending.source as any).openid }
            : { type: "group" as const, groupOpenid: (pending.source as any).groupOpenid };
          await this.api.sendLongMessage(target, reply);
        }
      } else if (choice === "new" && gate) {
        // Create new agent and process immediately
        const gateResult = await gate.createNewAgent(pending.userId);
        gate.markBusy(gateResult.agentId, pending.message.slice(0, 30));
        const reply = await processWithAgent(
          gateResult.sessionId, gateResult.agentId,
          pending.message, pending.msgId, pending.userId,
        );
        gate.markIdle(gateResult.agentId);
        // Send the reply
        if (this.api) {
          const target = pending.source.type === "c2c"
            ? { type: "c2c" as const, openid: (pending.source as any).openid }
            : { type: "group" as const, groupOpenid: (pending.source as any).groupOpenid };
          await this.api.sendLongMessage(target, reply);
        }
      }
    });

    // -----------------------------------------------------------------------
    // General interaction handler (routes to registered prefix handlers)
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
