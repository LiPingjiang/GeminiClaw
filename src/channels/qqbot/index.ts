// @ts-nocheck
// src/channels/qqbot/index.ts
// QQBotChannel: implements IChannel, supports websocket and webhook modes.
// Supports C2C, Group, and Interaction events.
import type { FastifyInstance } from "fastify";
import type { IChannel, ChannelContext } from "../types.js";
import type { Db } from "../../db/client.js";
import { messageText } from "../../providers/types.js";
import type { ContentPart } from "../../providers/types.js";
import { registerWebhookRoute } from "./webhook.js";
import { QQBotWSClient, DEFAULT_INTENTS } from "./ws-client.js";
import type { MessageSource, QQAttachment } from "./ws-client.js";
import { QQBotApi, parseInteractionEvent } from "./api.js";
import type { InteractionEvent, InlineKeyboard } from "./api.js";
import { sendC2CReply, buildBusyKeyboard, buildAgentSelectKeyboard } from "./api.js";
import { dispatch } from "../../commands/dispatcher.js";
import { AgentRepository } from "../../agents/repository.js";
import { AgentGate } from "../../guidance/agent-gate.js";
import type { GateResult } from "../../guidance/agent-gate.js";
import { stripToolXml } from "../../utils/strip-tool-xml.js";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { MemoryPaths } from "../../memory/paths.js";
import { MemoryWriter } from "../../memory/memory-writer.js";
import { WorkingMemoryBuilder } from "../../memory/working-memory.js";
import { MemoryManagerSession, MEMORY_MANAGER_PROMPT, renderExit } from "../../guidance/memory-manager.js";
import { resolveMemIntent } from "../../guidance/mem-intent.js";
import { homedir } from "node:os";
import { join as pathJoin } from "node:path";
import { traceHub } from "../../trace/hub.js";

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
    const { memory, agentLoop, config, consumeFallbackRoute } = ctx;
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

    // ── Memory manager (isolated /mem sessions) ──────────────────────────
    const memMgr = this.db ? new MemoryManagerSession(this.db) : null;
    const memoryRoot = pathJoin(homedir(), ".gemeniclaw");
    const memoryWriter = new MemoryWriter(new MemoryPaths(memoryRoot));

    // Drive the agent loop for a memory-management turn. Isolated: never
    // persists to the target agent's history (no appendMessages).
    const runMemoryManager = async (
      memSessionId: string,
      targetAgentId: string,
      content: string,
      userId: string,
    ): Promise<string> => {
      const messages = [
        { role: "system" as const, content: MEMORY_MANAGER_PROMPT },
        { role: "user" as const, content },
      ];
      const modelOverride = modelOverrides.get(userId);
      let finalReply = "";
      let _lastNonEmptyReply = "";
      for await (const event of agentLoop.run({
        messages,
        sessionId: memSessionId,
        ...(modelOverride ? { model: modelOverride } : {}),
        toolContextExtra: {
          ...(this.db ? { db: this.db } : {}),
          userId,
          memoryRoot,
          targetAgentId,
        },
      })) {
        if (event.type === "message_delta") {
          finalReply += event.delta;
        } else if (event.type === "turn_start") {
          if (finalReply) _lastNonEmptyReply = finalReply;
          finalReply = "";
        }
      }
      if (!finalReply && _lastNonEmptyReply) finalReply = _lastNonEmptyReply;
      if (!finalReply) finalReply = "（无回复）";
      return "🧠 记忆管家\n" + stripToolXml(finalReply);
    };

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
      attachments?: QQAttachment[],
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

      // ── 记忆管理拦截 ────────────────────────────────────────────────────
      if (memMgr) {
        const memIntent = resolveMemIntent(content);
        const memActive = memMgr.isActive(userId);
        // Only engage the manager when the user is already inside it, or is
        // explicitly entering. A bare "返回/退出" outside the manager falls
        // through to normal chat (no false "已退出" reply).
        if (memActive || memIntent?.action === "enter") {
          if (memIntent?.action === "exit" && memActive) {
            const ms = memMgr.getActive(userId)!;
            const recent = memMgr.recentDialog(ms.targetAgentId, 5);
            const name = ms.targetAgentName;
            memMgr.exit(userId);
            return renderExit(name, recent);
          }
          if (memIntent?.action === "enter" && !memActive) {
            const sticky = this.db!
              .prepare("SELECT agent_id, agent_name FROM user_sessions WHERE openid = ?")
              .get(userId) as { agent_id: string; agent_name: string } | undefined;
            if (!sticky) {
              return "你当前还没有活跃助手，先聊两句创建一个再来整理记忆。";
            }
            const ms = memMgr.enter(userId, sticky.agent_id, sticky.agent_name);
            let usageLine = "";
            try {
              const wm = new WorkingMemoryBuilder(new MemoryPaths(memoryRoot));
              const today = new Date().toISOString().slice(0, 10);
              usageLine =
                wm.renderUsageSummary(ms.targetAgentId, today) +
                "\n（随时说「返回」即可切回助手）\n\n";
            } catch {
              usageLine = "（随时说「返回」即可切回助手）\n\n";
            }
            const reply = await runMemoryManager(
              ms.sessionId,
              ms.targetAgentId,
              `请先查看 ${sticky.agent_name} 的记忆全景，并简要汇报各层现状。`,
              userId,
            );
            return usageLine + reply;
          }
          // 已在记忆管理中 → 路由到记忆管家
          const ms = memMgr.getActive(userId)!;
          return await runMemoryManager(ms.sessionId, ms.targetAgentId, content, userId);
        }
      }

      // ── AgentGate: busy 检测 ────────────────────────────────────────────
      let sessionId = userId;
      let currentAgentId: string | null = null;
      if (gate) {
        // Check if user's agent is busy
        const busyInfo = gate.checkBusy(userId);
        console.log(`[AgentGate] checkBusy(${userId.slice(0, 8)}…) → ${busyInfo ? `BUSY: ${busyInfo.currentWork}` : "idle"}`);
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
      const runSignal = gate && currentAgentId ? gate.getSignal(currentAgentId) : undefined;
      try {
        const reply = await processWithAgent(sessionId, currentAgentId, content, _msgId, userId, runSignal, attachments);
        return reply;
      } finally {
        // ALWAYS mark idle, even if processWithAgent throws or agent loop hangs
        if (gate && currentAgentId) {
          gate.markIdle(currentAgentId);
        }
      }
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
      signal?: AbortSignal,
      attachments?: QQAttachment[],
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

      const convCtx = await memory.getContext(sessionId, content, agentId ?? undefined);

      // ── Inject current agent identity (fixed working memory, never compacted) ──
      let agentIdentityMsg: { role: "system"; content: string } | null = null;
      let currentAgentDisplayName: string | null = null;
      if (agentId && this.db) {
        const agentRow = this.db
          .prepare("SELECT agent_name, description FROM agents WHERE id = ?")
          .get(agentId) as { agent_name: string; description: string | null } | undefined;
        if (agentRow) {
          currentAgentDisplayName = agentRow.agent_name;
          // Identity is normally injected by WorkingMemoryBuilder via the agent
          // fixed zone (agents/<id>/AGENT.md). Only fall back to a DB-derived
          // system message when that file does not yet exist (pre-migration).
          const hasFixedOnDisk = existsSync(new MemoryPaths().agentAgentMd(agentId));
          if (!hasFixedOnDisk) {
            agentIdentityMsg = {
              role: "system" as const,
              content: `## 当前助手身份\n你现在以【${agentRow.agent_name}】身份工作。${agentRow.description ? "\n职责：" + agentRow.description : ""}`,
            };
          }
        }
      }

      // ── Build user message content: text + optional image attachments ──
      let userContent: string | ContentPart[];
      if (attachments && attachments.length > 0) {
        const parts: ContentPart[] = [];
        if (content) {
          parts.push({ type: "text", text: content });
        }
        for (const att of attachments) {
          // QQ image URLs need https:// prefix
          const imgUrl = att.url.startsWith("//") ? `https:${att.url}` : att.url;
          // Download image and convert to base64 data URI
          // QQ multimedia CDN requires Authorization header with bot access token
          try {
            const token = await this.api!.getToken();
            const imgResp = await fetch(imgUrl, {
              headers: { Authorization: `QQBot ${token}` },
            });
            if (imgResp.ok) {
              const buf = Buffer.from(await imgResp.arrayBuffer());
              const mime = att.content_type || imgResp.headers.get("content-type") || "image/jpeg";
              const b64 = buf.toString("base64");
              const dataUri = `data:${mime};base64,${b64}`;
              parts.push({ type: "image_url", image_url: { url: dataUri, detail: "auto" } });
              console.log(`[QQBot] Downloaded image (${buf.length} bytes) as base64 data URI`);
            } else {
              console.warn(`[QQBot] Image download failed (${imgResp.status}), trying without auth...`);
              // Fallback: try without auth (some CDN URLs are publicly accessible)
              const fallbackResp = await fetch(imgUrl);
              if (fallbackResp.ok) {
                const buf = Buffer.from(await fallbackResp.arrayBuffer());
                const mime = att.content_type || fallbackResp.headers.get("content-type") || "image/jpeg";
                const b64 = buf.toString("base64");
                const dataUri = `data:${mime};base64,${b64}`;
                parts.push({ type: "image_url", image_url: { url: dataUri, detail: "auto" } });
                console.log(`[QQBot] Downloaded image without auth (${buf.length} bytes)`);
              } else {
                console.error(`[QQBot] Image download failed completely (${fallbackResp.status}), skipping`);
                parts.push({ type: "text", text: `[图片无法下载: ${att.filename || "unknown"}]` });
              }
            }
          } catch (err) {
            console.error(`[QQBot] Image download error:`, err);
            parts.push({ type: "text", text: `[图片下载失败: ${att.filename || "unknown"}]` });
          }
        }
        if (parts.length === 0) {
          parts.push({ type: "text", text: "(image)" });
        }
        userContent = parts;
      } else {
        userContent = content;
      }

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
        // Inject agent identity as a system message (never persisted/compacted)
        ...(agentIdentityMsg ? [agentIdentityMsg] : []),
        { role: "user" as const, content: userContent },
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

      // ── TraceHub 埋点：把每个 AgentEvent 推给 gc watch ──────────────
      const _traceUserId = userId.length > 8 ? userId.slice(0, 8) + "..." : userId;

      for await (const event of agentLoop.run({
        messages,
        sessionId,
        ...(modelOverride ? { model: modelOverride } : {}),
        ...(signal ? { signal } : {}),
        toolContextExtra: {
          ...(this.db ? { db: this.db } : {}),
          userId,
          msgId,
          appId,
          clientSecret,
          memoryRoot,
          targetAgentId: agentId,
        },
      })) {
        // 发布到 TraceHub（fire-and-forget，不阻塞主流程）
        traceHub.publish({
          ts: Date.now(),
          userId: _traceUserId,
          sessionId,
          agentEvent: event as unknown as Record<string, unknown>,
        });

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

      // ── 打断退出：把已完成的部分 flush 进 memory，保留上下文 ──────────
      if (signal?.aborted) {
        const userMsg = { role: "user" as const, content };
        const partialMessages: Array<Record<string, unknown>> = [userMsg];
        if (turnMessages.length > 0) {
          partialMessages.push(...turnMessages);
        }
        // 只有有实质内容时才持久化（避免写入空记录）
        if (partialMessages.length > 1) {
          await memory.appendMessages(
            sessionId,
            partialMessages as Parameters<typeof memory.appendMessages>[1],
          );
        }
        return ""; // 调用方感知到打断，不发送回复
      }

      // 兜底：若最终轮为空，使用上一轮的有效回复
      if (!finalReply && _lastNonEmptyReply) finalReply = _lastNonEmptyReply;
      if (!finalReply) finalReply = "（无回复）";
      finalReply = stripToolXml(finalReply);

      // ── Fallback 注脚：当使用了非主模型时提示用户 ──────────────────────
      const fallbackRoute = consumeFallbackRoute?.();
      if (fallbackRoute) {
        finalReply += `\n\n[fallback:${fallbackRoute}]`;
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

      // ── Auto-persist this turn into daily memory (non-fatal) ──────────
      try {
        await memoryWriter.recordTurn({
          userText: content,
          assistantText: finalReply,
          date: new Date().toISOString().slice(0, 10),
          agentId,
        });
      } catch (e) {
        console.warn("[QQBotChannel] memoryWriter.recordTurn failed (non-fatal):", String(e));
      }

      // ── Prepend bold agent name as first line (display only, not persisted) ──
      if (currentAgentDisplayName) {
        finalReply = `**${currentAgentDisplayName}**\n${finalReply}`;
      }
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
      console.log(`[AgentGate] INTERACTION received: choice=${choice}, requestId=${requestId}, user=${event.userOpenid.slice(0, 8)}…`);

      const pending = pendingBusy.get(requestId);
      if (!pending) {
        console.warn("[QQBotChannel] busy interaction for unknown requestId:", requestId, "(possibly expired after restart)");
        // Give user feedback instead of silently ignoring
        if (this.api) {
          const target = event.chatType === "group" && event.groupOpenid
            ? { type: "group" as const, groupOpenid: event.groupOpenid }
            : { type: "c2c" as const, openid: event.userOpenid };
          await this.api.sendActive(target, "⚠️ 该操作已过期（可能由于助手重启），请重新发送消息。");
        }
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
        let reply: string;
        try {
          reply = await processWithAgent(
            gateResult.sessionId, gateResult.agentId,
            pending.message, pending.msgId, pending.userId,
          );
        } finally {
          gate.markIdle(gateResult.agentId);
        }
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
        const newSignal = gate.getSignal(gateResult.agentId);
        let reply: string;
        try {
          reply = await processWithAgent(
            gateResult.sessionId, gateResult.agentId,
            pending.message, pending.msgId, pending.userId, newSignal,
          );
        } finally {
          gate.markIdle(gateResult.agentId);
        }
        // Send the reply
        if (this.api) {
          const target = pending.source.type === "c2c"
            ? { type: "c2c" as const, openid: (pending.source as any).openid }
            : { type: "group" as const, groupOpenid: (pending.source as any).groupOpenid };
          await this.api.sendLongMessage(target, reply);
        }
      } else if (choice === "interrupt" && gate) {
        // Interrupt the current run, then process the new message on the same agent
        const currentAgentId = gate.getUserAgentId(pending.userId);
        if (!currentAgentId) return;

        // 1. Abort the running agentLoop — it will exit at the next turn boundary
        gate.interruptAgent(currentAgentId);

        // 2. Wait for the agent to become idle (markIdle is called in the finally block of processWithAgent)
        const gateResult = await gate.queueForAgent(pending.userId, pending.message);

        // 3. Process the new message on the same session (preserving context)
        gate.markBusy(gateResult.agentId, pending.message.slice(0, 30));
        const interruptSignal = gate.getSignal(gateResult.agentId);
        let reply: string;
        try {
          reply = await processWithAgent(
            gateResult.sessionId, gateResult.agentId,
            pending.message, pending.msgId, pending.userId, interruptSignal,
          );
        } finally {
          gate.markIdle(gateResult.agentId);
        }
        // Send the reply (only if non-empty)
        if (reply && this.api) {
          const target = pending.source.type === "c2c"
            ? { type: "c2c" as const, openid: (pending.source as any).openid }
            : { type: "group" as const, groupOpenid: (pending.source as any).groupOpenid };
          await this.api.sendLongMessage(target, reply);
        }
      } else if (choice === "select" && gate) {
        // Show agent selection keyboard listing ALL active agents (idle AND busy).
        const agents = gate.listUserAgents(pending.userId);
        const target = pending.source.type === "c2c"
          ? { type: "c2c" as const, openid: (pending.source as any).openid }
          : { type: "group" as const, groupOpenid: (pending.source as any).groupOpenid };

        if (agents.length === 0) {
          // No agents at all — offer to create new
          if (this.api) {
            await this.api.sendActive(
              target,
              "📋 当前没有可选助手，请新建一个。",
              buildBusyKeyboard(requestId),
            );
            pendingBusy.set(requestId, pending);
          }
        } else {
          // Show agent selection keyboard — keep pendingBusy alive for selagent handler
          pendingBusy.set(requestId, pending);
          if (this.api) {
            const keyboard = buildAgentSelectKeyboard(requestId, agents, 0);
            await this.api.sendActive(target, "📋 选择一个助手来处理你的消息（🟢闲 / 🔴忙）：", keyboard);
          }
        }
      }
    });

    // -----------------------------------------------------------------------
    // Agent-selection interaction handler
    // -----------------------------------------------------------------------
    registerInteractionHandler("selagent:", async (event: InteractionEvent) => {
      const parts = event.buttonData.split(":");
      // Format: "selagent:{requestId}:{agentId|back}"
      if (parts.length < 3) return;
      const requestId = parts[1];
      const action = parts[2]; // agentId or "back"
      console.log(`[AgentGate] SELAGENT interaction: action=${action}, requestId=${requestId}`);

      const pending = pendingBusy.get(requestId);
      if (!pending) {
        console.warn("[QQBotChannel] selagent interaction for unknown requestId:", requestId);
        if (this.api) {
          const target = event.chatType === "group" && event.groupOpenid
            ? { type: "group" as const, groupOpenid: event.groupOpenid }
            : { type: "c2c" as const, openid: event.userOpenid };
          await this.api.sendActive(target, "⚠️ 该操作已过期，请重新发送消息。");
        }
        return;
      }

      const target = pending.source.type === "c2c"
        ? { type: "c2c" as const, openid: (pending.source as any).openid }
        : { type: "group" as const, groupOpenid: (pending.source as any).groupOpenid };

      if (action === "back") {
        // Return to busy keyboard — keep pendingBusy alive
        pendingBusy.set(requestId, pending);
        if (this.api) {
          await this.api.sendActive(target, "⏳ 请选择操作：", buildBusyKeyboard(requestId));
        }
        return;
      }

      if (!gate) return;

      // Pagination: "page:{n}" re-renders the agent list at the requested page.
      if (action === "page") {
        const page = parseInt(parts[3] ?? "0", 10) || 0;
        pendingBusy.set(requestId, pending);
        if (this.api) {
          const agents = gate.listUserAgents(pending.userId);
          const keyboard = buildAgentSelectKeyboard(requestId, agents, page);
          await this.api.sendActive(target, "📋 选择一个助手来处理你的消息（🟢闲 / 🔴忙）：", keyboard);
        }
        return;
      }

      // action is an agentId — user selected a specific agent
      const selectedAgentId = action;

      // If the selected agent is busy, switch to it (set sticky) and let the user
      // decide how to handle the conflict: queue, interrupt, or new agent.
      if (gate.isBusy(selectedAgentId)) {
        await gate.switchToAgent(pending.userId, selectedAgentId);
        pendingBusy.set(requestId, pending);
        if (this.api) {
          await this.api.sendActive(
            target,
            "⚠️ 该助手正在忙，你希望如何处理？",
            buildBusyKeyboard(requestId),
          );
        }
        return;
      }

      // Idle agent — switch and process immediately.
      pendingBusy.delete(requestId);
      const gateResult = await gate.switchToAgent(pending.userId, selectedAgentId);
      gate.markBusy(gateResult.agentId, pending.message.slice(0, 30));
      const selectSignal = gate.getSignal(gateResult.agentId);
      let reply: string;
      try {
        reply = await processWithAgent(
          gateResult.sessionId, gateResult.agentId,
          pending.message, pending.msgId, pending.userId, selectSignal,
        );
      } finally {
        gate.markIdle(gateResult.agentId);
      }
      // Send the reply
      if (reply && this.api) {
        await this.api.sendLongMessage(target, reply);
      }
    });

    // -----------------------------------------------------------------------
    // General interaction handler (routes to registered prefix handlers)
    // -----------------------------------------------------------------------
    const handleInteraction = async (event: InteractionEvent): Promise<void> => {
      console.log(`[QQBotChannel] INTERACTION_CREATE: buttonData="${event.buttonData}", user=${event.userOpenid.slice(0, 8)}…, chatType=${event.chatType}`);
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
