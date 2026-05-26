// src/channels/qqbot/ws-client.ts
// QQBot WebSocket long-connection client.
import WebSocket from "ws";
import { getAccessToken, sendC2CReply, sendC2CActive } from "./api.js";

const QQ_WS_URL = "wss://api.sgroup.qq.com/websocket";
const MAX_RETRIES = 10;
const RETRY_DELAY_MS = 5000;

export interface QQBotWSOptions {
  appId: string;
  clientSecret: string;
  /** 默认 1073741824 (C2C 消息 intent) */
  intents?: number;
  onMessage: (
    openid: string,
    content: string,
    msgId: string,
  ) => Promise<string>;
}

export class QQBotWSClient {
  private opts: QQBotWSOptions;
  private ws: WebSocket | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private sessionId: string | null = null;
  private lastSeq: number | null = null;
  private retryCount = 0;
  private stopped = false;

  constructor(opts: QQBotWSOptions) {
    this.opts = opts;
  }

  async connect(): Promise<void> {
    this.stopped = false;
    await this._connect();
  }

  disconnect(): void {
    this.stopped = true;
    this._cleanup();
  }

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

  private async _connect(): Promise<void> {
    this._cleanup();
    let token: string;
    try {
      token = await getAccessToken(this.opts.appId, this.opts.clientSecret);
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
    const ws = new WebSocket(QQ_WS_URL);
    this.ws = ws;

    ws.on("open", () => {
      console.log("[QQBotWSClient] WebSocket connected");
      this.retryCount = 0;
    });

    ws.on("message", (data) => {
      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(data.toString()) as Record<string, unknown>;
      } catch {
        return;
      }
      if (payload.s !== undefined) {
        this.lastSeq = payload.s as number;
      }
      this._handlePayload(payload, token);
    });

    ws.on("close", (code, reason) => {
      console.warn(
        `[QQBotWSClient] WebSocket closed: code=${code} reason=${reason.toString()}`,
      );
      if (!this.stopped) {
        this._scheduleReconnect();
      }
    });

    ws.on("error", (err) => {
      console.error("[QQBotWSClient] WebSocket error:", err);
    });
  }

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
      case 10: {
        const hello = d as { heartbeat_interval?: number } | null;
        const interval = hello?.heartbeat_interval ?? 30000;
        this._startHeartbeat(interval);
        this._identify(token);
        break;
      }
      case 0: {
        if (t === "READY") {
          const ready = d as { session_id?: string } | null;
          this.sessionId = ready?.session_id ?? null;
          console.log(
            `[QQBotWSClient] READY, session_id=${this.sessionId}`,
          );
        } else if (t === "C2C_MESSAGE_CREATE") {
          void this._handleC2CMessage(d);
        }
        break;
      }
      case 7:
        console.warn("[QQBotWSClient] op=7 Reconnect requested");
        this._scheduleReconnect();
        break;
      case 9:
        console.warn("[QQBotWSClient] op=9 Invalid session, re-identifying");
        this._identify(token);
        break;
      case 11:
        break;
      default:
        break;
    }
  }

  private _startHeartbeat(intervalMs: number): void {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
    }
    this.heartbeatTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        const payload = { op: 1, d: this.lastSeq };
        this.ws.send(JSON.stringify(payload));
      }
    }, intervalMs);
  }

  private _identify(token: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const intents = this.opts.intents ?? 1073741824;
    const payload = {
      op: 2,
      d: {
        token: `QQBot ${token}`,
        intents,
        shard: [0, 1],
      },
    };
    this.ws.send(JSON.stringify(payload));
  }

  private async _handleC2CMessage(d: unknown): Promise<void> {
    const msg = d as {
      author?: { user_openid?: string; id?: string };
      content?: string;
      id?: string;
    } | null;
    const openid =
      msg?.author?.user_openid ?? msg?.author?.id ?? "";
    const content = (msg?.content ?? "").trim();
    const msgId = msg?.id ?? "";
    if (!openid || !content) return;

    let reply = "";
    try {
      reply = await this.opts.onMessage(openid, content, msgId);
    } catch (err) {
      console.error("[QQBotWSClient] AgentLoop error:", err);
      await sendC2CActive(
        this.opts.appId,
        this.opts.clientSecret,
        openid,
        "❌ 处理出错：" + String(err),
      ).catch((e) =>
        console.error("[QQBotWSClient] sendC2CActive error:", e),
      );
      return;
    }

    try {
      await sendC2CReply(
        this.opts.appId,
        this.opts.clientSecret,
        openid,
        reply,
        msgId,
      );
    } catch (replyErr) {
      console.warn(
        "[QQBotWSClient] Passive reply failed, falling back to active message:",
        replyErr,
      );
      await sendC2CActive(
        this.opts.appId,
        this.opts.clientSecret,
        openid,
        reply,
      ).catch((e) =>
        console.error("[QQBotWSClient] sendC2CActive fallback error:", e),
      );
    }
  }

  private _scheduleReconnect(): void {
    if (this.stopped) return;
    if (this.retryCount >= MAX_RETRIES) {
      console.error("[QQBotWSClient] Max retries reached, giving up");
      return;
    }
    this.retryCount++;
    console.log(
      `[QQBotWSClient] Reconnecting in ${RETRY_DELAY_MS}ms (attempt ${this.retryCount}/${MAX_RETRIES})`,
    );
    setTimeout(() => {
      if (!this.stopped) {
        void this._connect();
      }
    }, RETRY_DELAY_MS);
  }
}
