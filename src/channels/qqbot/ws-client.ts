// src/channels/qqbot/ws-client.ts
// QQBot WebSocket long-connection client — production-grade implementation.
// Features: Session Resume, exponential backoff, close code classification,
//           C2C + Group + Interaction event support.
import WebSocket from "ws";
import { QQBotApi, parseInteractionEvent } from "./api.js";
import type { InteractionEvent, InlineKeyboard } from "./api.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const QQ_GATEWAY_URL = "https://api.sgroup.qq.com/gateway";
const QQ_WS_FALLBACK = "wss://api.sgroup.qq.com/websocket";
const RECONNECT_BACKOFF = [2000, 5000, 10000, 30000, 60000]; // ms
const MAX_RETRIES = 50;
const QUICK_DISCONNECT_THRESHOLD_MS = 5000;
const MAX_QUICK_DISCONNECTS = 3;

// Intent bits
export const INTENT_C2C_MESSAGE = 1 << 25;  // C2C_MESSAGE_CREATE
export const INTENT_GROUP_AT_MSG = 1 << 25;  // GROUP_AT_MESSAGE_CREATE (same bit)
export const INTENT_PUBLIC_GUILD = 1 << 30;  // PUBLIC_GUILD_MESSAGES (legacy)
export const INTENT_INTERACTION = 1 << 26;   // INTERACTION_CREATE
export const INTENT_DIRECT_MSG = 1 << 12;    // DIRECT_MESSAGE_CREATE

export const DEFAULT_INTENTS = INTENT_C2C_MESSAGE | INTENT_INTERACTION;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
export type MessageSource =
  | { type: "c2c"; openid: string }
  | { type: "group"; groupOpenid: string; userOpenid: string };

/** Attachment from QQ message (image, file, etc.) */
export interface QQAttachment {
  content_type: string;
  url: string;
  filename?: string;
}

export interface QQBotWSOptions {
  appId: string;
  clientSecret: string;
  /** Intents bitmask. Default: C2C + INTERACTION */
  intents?: number;
  /** Message handler for text messages (C2C and Group) */
  onMessage: (
    source: MessageSource,
    content: string,
    msgId: string,
    attachments?: QQAttachment[],
  ) => Promise<string>;
  /** Interaction (button click) handler */
  onInteraction?: (event: InteractionEvent) => Promise<void>;
}

// ---------------------------------------------------------------------------
// Close code classification
// ---------------------------------------------------------------------------
type CloseAction = "resume" | "reconnect" | "fatal" | "rate_limit";

function classifyCloseCode(code: number): CloseAction {
  switch (code) {
    case 4004: return "reconnect"; // token invalid
    case 4006: return "reconnect"; // session invalid, need new session
    case 4007: return "resume";    // seq too old, can resume
    case 4008: return "rate_limit"; // rate limited
    case 4009: return "resume";    // session timed out
    case 4914:
    case 4915: return "fatal";     // permanently banned
    default:
      if (code >= 4000 && code <= 4099) return "reconnect";
      return "reconnect";
  }
}

// ---------------------------------------------------------------------------
// QQBotWSClient
// ---------------------------------------------------------------------------
export class QQBotWSClient {
  private opts: QQBotWSOptions;
  private api: QQBotApi;
  private ws: WebSocket | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private sessionId: string | null = null;
  private lastSeq: number | null = null;
  private retryCount = 0;
  private stopped = false;
  private fatalError = false;
  private connectedAt = 0;
  private quickDisconnects = 0;
  private gatewayUrl: string | null = null;

  constructor(opts: QQBotWSOptions) {
    this.opts = opts;
    this.api = new QQBotApi({ appId: opts.appId, clientSecret: opts.clientSecret });
  }

  getApi(): QQBotApi {
    return this.api;
  }

  async connect(): Promise<void> {
    this.stopped = false;
    this.fatalError = false;
    await this._connect();
  }

  disconnect(): void {
    this.stopped = true;
    this._cleanup();
  }

  // -------------------------------------------------------------------------
  // Connection management
  // -------------------------------------------------------------------------
  private _cleanup(): void {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.close();
      this.ws = null;
    }
  }

  private async _getGatewayUrl(): Promise<string> {
    if (this.gatewayUrl) return this.gatewayUrl;
    try {
      const token = await this.api.getToken();
      const res = await fetch(QQ_GATEWAY_URL, {
        headers: { Authorization: `QQBot ${token}` },
      });
      if (res.ok) {
        const data = (await res.json()) as { url?: string };
        if (data.url) {
          this.gatewayUrl = data.url;
          return data.url;
        }
      }
    } catch {
      // fallback
    }
    return QQ_WS_FALLBACK;
  }

  private async _connect(): Promise<void> {
    this._cleanup();
    let token: string;
    try {
      token = await this.api.getToken();
    } catch (err) {
      console.error("[QQBotWSClient] Failed to get access token:", err);
      this._scheduleReconnect();
      return;
    }
    if (!token) {
      console.error("[QQBotWSClient] Empty access token, will retry");
      this._scheduleReconnect();
      return;
    }

    const wsUrl = await this._getGatewayUrl();
    const ws = new WebSocket(wsUrl);
    this.ws = ws;

    ws.on("open", () => {
      console.log("[QQBotWSClient] WebSocket connected");
      this.connectedAt = Date.now();
      this.retryCount = 0;
    });

    ws.on("message", (data) => {
      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(data.toString()) as Record<string, unknown>;
      } catch {
        return;
      }
      if (payload.s !== undefined && payload.s !== null) {
        this.lastSeq = payload.s as number;
      }
      this._handlePayload(payload, token);
    });

    ws.on("close", (code, reason) => {
      console.warn(
        `[QQBotWSClient] WebSocket closed: code=${code} reason=${reason.toString()}`,
      );
      if (this.stopped) return;

      // Quick disconnect detection
      if (Date.now() - this.connectedAt < QUICK_DISCONNECT_THRESHOLD_MS) {
        this.quickDisconnects++;
        if (this.quickDisconnects >= MAX_QUICK_DISCONNECTS) {
          console.error("[QQBotWSClient] FATAL: too many quick disconnects");
          this.fatalError = true;
          return;
        }
      } else {
        this.quickDisconnects = 0;
      }

      const action = classifyCloseCode(code);
      switch (action) {
        case "fatal":
          console.error("[QQBotWSClient] FATAL close code:", code);
          this.fatalError = true;
          break;
        case "rate_limit":
          console.warn("[QQBotWSClient] Rate limited, waiting 60s");
          setTimeout(() => { if (!this.stopped) void this._connect(); }, 60000);
          break;
        case "resume":
          if (this.sessionId && this.lastSeq !== null) {
            this._reconnectForResume(token);
          } else {
            this._scheduleReconnect();
          }
          break;
        case "reconnect":
        default:
          // Clear session for fresh connect
          if (code === 4004) this.api.invalidateToken();
          if (code === 4006) this.sessionId = null;
          this._scheduleReconnect();
          break;
      }
    });

    ws.on("error", (err) => {
      console.error("[QQBotWSClient] WebSocket error:", err);
    });
  }

  // -------------------------------------------------------------------------
  // Payload handling
  // -------------------------------------------------------------------------
  private _handlePayload(
    payload: Record<string, unknown>,
    token: string,
  ): void {
    const { op, d, t } = payload as {
      op: number;
      d: unknown;
      t?: string;
    };
    switch (op) {
      case 10: { // Hello
        const hello = d as { heartbeat_interval?: number } | null;
        const interval = hello?.heartbeat_interval ?? 30000;
        this._startHeartbeat(Math.floor(interval * 0.8)); // 80% of server interval
        // Resume or Identify
        if (this.sessionId && this.lastSeq !== null) {
          this._sendResume(token);
        } else {
          this._identify(token);
        }
        break;
      }
      case 0: { // Dispatch
        this._handleDispatch(t, d);
        break;
      }
      case 7: // Server requests reconnect
        console.warn("[QQBotWSClient] op=7 Reconnect requested");
        this._reconnectForResume(token);
        break;
      case 9: { // Invalid session
        const resumable = d as boolean;
        if (resumable && this.sessionId) {
          console.warn("[QQBotWSClient] op=9 Invalid session (resumable)");
          this._sendResume(token);
        } else {
          console.warn("[QQBotWSClient] op=9 Invalid session (not resumable)");
          this.sessionId = null;
          this.lastSeq = null;
          this._identify(token);
        }
        break;
      }
      case 11: // Heartbeat ACK
        break;
      default:
        break;
    }
  }

  private _handleDispatch(t: string | undefined, d: unknown): void {
    switch (t) {
      case "READY": {
        const ready = d as { session_id?: string } | null;
        this.sessionId = ready?.session_id ?? null;
        console.log(`[QQBotWSClient] READY, session_id=${this.sessionId}`);
        break;
      }
      case "RESUMED":
        console.log("[QQBotWSClient] RESUMED successfully");
        break;
      case "C2C_MESSAGE_CREATE":
        void this._handleC2CMessage(d);
        break;
      case "GROUP_AT_MESSAGE_CREATE":
      case "GROUP_MESSAGE_CREATE":
        void this._handleGroupMessage(d);
        break;
      case "INTERACTION_CREATE":
        void this._handleInteraction(d);
        break;
      default:
        break;
    }
  }

  // -------------------------------------------------------------------------
  // Message handlers
  // -------------------------------------------------------------------------
  private async _handleC2CMessage(d: unknown): Promise<void> {
    // DEBUG: Log raw C2C message payload to understand image format
    console.log("[QQBotWSClient] C2C_MESSAGE raw payload:", JSON.stringify(d, null, 2)?.slice(0, 2000));

    const msg = d as {
      author?: { user_openid?: string; id?: string };
      content?: string;
      id?: string;
      attachments?: Array<{ content_type?: string; url?: string; filename?: string }>;
    } | null;
    const openid = msg?.author?.user_openid ?? msg?.author?.id ?? "";
    const content = (msg?.content ?? "").trim();
    const msgId = msg?.id ?? "";

    // Extract image attachments
    const attachments: QQAttachment[] = (msg?.attachments ?? [])
      .filter((a) => a.url && a.content_type?.startsWith("image/"))
      .map((a) => ({
        content_type: a.content_type!,
        url: a.url!,
        filename: a.filename,
      }));

    // Allow message if it has content OR attachments (user may send image-only)
    if (!openid || (!content && attachments.length === 0)) return;

    // Dedup
    if (this.api.isDuplicate(msgId)) return;

    const source: MessageSource = { type: "c2c", openid };
    await this._processMessage(source, content, msgId, attachments);
  }

  private async _handleGroupMessage(d: unknown): Promise<void> {
    const msg = d as {
      group_openid?: string;
      author?: { member_openid?: string; id?: string };
      content?: string;
      id?: string;
      attachments?: Array<{ content_type?: string; url?: string; filename?: string }>;
    } | null;
    const groupOpenid = msg?.group_openid ?? "";
    const userOpenid = msg?.author?.member_openid ?? msg?.author?.id ?? "";
    let content = (msg?.content ?? "").trim();
    const msgId = msg?.id ?? "";

    // Extract image attachments
    const attachments: QQAttachment[] = (msg?.attachments ?? [])
      .filter((a) => a.url && a.content_type?.startsWith("image/"))
      .map((a) => ({
        content_type: a.content_type!,
        url: a.url!,
        filename: a.filename,
      }));

    if (!groupOpenid || (!content && attachments.length === 0)) return;

    // Dedup
    if (this.api.isDuplicate(msgId)) return;

    // Strip @bot mention prefix (common pattern: /@ <botname> actual message)
    content = content.replace(/^<@!\d+>\s*/, "").trim();
    if (!content && attachments.length === 0) return;

    const source: MessageSource = { type: "group", groupOpenid, userOpenid };
    await this._processMessage(source, content, msgId, attachments);
  }

  private async _handleInteraction(d: unknown): Promise<void> {
    const event = parseInteractionEvent(d as Record<string, unknown>);
    if (!event) return;

    // ACK immediately (must respond within 3s or user sees error icon)
    await this.api.acknowledgeInteraction(event.interactionId).catch((err) =>
      console.error("[QQBotWSClient] ACK interaction error:", err),
    );

    // Route to handler
    if (this.opts.onInteraction) {
      try {
        await this.opts.onInteraction(event);
      } catch (err) {
        console.error("[QQBotWSClient] onInteraction error:", err);
      }
    }
  }

  private async _processMessage(
    source: MessageSource,
    content: string,
    msgId: string,
    attachments?: QQAttachment[],
  ): Promise<void> {
    const target = source.type === "c2c"
      ? { type: "c2c" as const, openid: source.openid }
      : { type: "group" as const, groupOpenid: source.groupOpenid };

    const PASSIVE_REPLY_WINDOW_MS = 4 * 60 * 1000;
    const taskStart = Date.now();

    // Keep-alive: send typing / "processing" after 30s
    const keepAliveTimer = setTimeout(() => {
      this.api.sendActive(target, "⏳ 正在处理中，请稍候…").catch((e) =>
        console.error("[QQBotWSClient] keepAlive error:", e),
      );
    }, 30_000);

    let reply = "";
    try {
      reply = await this.opts.onMessage(source, content, msgId, attachments?.length ? attachments : undefined);
    } catch (err) {
      clearTimeout(keepAliveTimer);
      console.error("[QQBotWSClient] onMessage error:", err);
      await this.api.sendActive(target, "❌ 处理出错：" + String(err)).catch((e) =>
        console.error("[QQBotWSClient] error notify failed:", e),
      );
      return;
    }
    clearTimeout(keepAliveTimer);

    // Auto-chunk long messages
    const elapsed = Date.now() - taskStart;
    if (elapsed > PASSIVE_REPLY_WINDOW_MS) {
      // Window expired, use active message
      await this.api.sendLongMessage(target, reply).catch((e) =>
        console.error("[QQBotWSClient] sendLongMessage (active) error:", e),
      );
    } else {
      // Try passive reply, fallback to active
      try {
        await this.api.sendLongMessage(target, reply, msgId);
      } catch (replyErr) {
        console.warn("[QQBotWSClient] Passive reply failed, fallback to active:", replyErr);
        await this.api.sendLongMessage(target, reply).catch((e) =>
          console.error("[QQBotWSClient] sendLongMessage fallback error:", e),
        );
      }
    }
  }

  // -------------------------------------------------------------------------
  // WebSocket protocol
  // -------------------------------------------------------------------------
  private _startHeartbeat(intervalMs: number): void {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
    }
    this.heartbeatTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ op: 1, d: this.lastSeq }));
      }
    }, intervalMs);
  }

  private _identify(token: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const intents = this.opts.intents ?? DEFAULT_INTENTS;
    this.ws.send(JSON.stringify({
      op: 2,
      d: {
        token: `QQBot ${token}`,
        intents,
        shard: [0, 1],
      },
    }));
  }

  private _sendResume(token: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({
      op: 6,
      d: {
        token: `QQBot ${token}`,
        session_id: this.sessionId,
        seq: this.lastSeq,
      },
    }));
    console.log("[QQBotWSClient] Sent RESUME (session=%s, seq=%d)", this.sessionId, this.lastSeq);
  }

  private _reconnectForResume(token: string): void {
    this._cleanup();
    // Immediate reconnect for resume (no backoff)
    setTimeout(() => {
      if (!this.stopped) void this._connect();
    }, 1000);
  }

  // -------------------------------------------------------------------------
  // Reconnection with exponential backoff
  // -------------------------------------------------------------------------
  private _scheduleReconnect(): void {
    if (this.stopped || this.fatalError) return;
    if (this.retryCount >= MAX_RETRIES) {
      console.error("[QQBotWSClient] Max retries reached, giving up");
      this.fatalError = true;
      return;
    }
    const delay = RECONNECT_BACKOFF[Math.min(this.retryCount, RECONNECT_BACKOFF.length - 1)];
    this.retryCount++;
    console.log(
      `[QQBotWSClient] Reconnecting in ${delay}ms (attempt ${this.retryCount}/${MAX_RETRIES})`,
    );
    setTimeout(() => {
      if (!this.stopped && !this.fatalError) {
        void this._connect();
      }
    }, delay);
  }
}
