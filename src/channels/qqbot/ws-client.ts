// src/channels/qqbot/ws-client.ts
// QQBot WebSocket long-connection client.

import WebSocket from "ws"
import { getAccessToken, sendC2CReply } from "./api.js"

export interface QQBotWSOptions {
  appId: string
  clientSecret: string
  /** 默认 1073741824 (C2C 消息 intent) */
  intents?: number
  onMessage: (openid: string, content: string, msgId: string) => Promise<string>
}

interface WSPayload {
  op: number
  d?: unknown
  t?: string
  s?: number
}

const QQ_WS_URL = "wss://api.sgroup.qq.com/websocket"
const MAX_RETRIES = 10
const RETRY_DELAY_MS = 5000

export class QQBotWSClient {
  private ws: WebSocket | null = null
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private sessionId: string | null = null
  private lastSeq: number | null = null
  private retryCount = 0
  private stopped = false

  constructor(private opts: QQBotWSOptions) {}

  async connect(): Promise<void> {
    this.stopped = false
    await this._connect()
  }

  disconnect(): void {
    this.stopped = true
    this._cleanup()
  }

  private _cleanup(): void {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
    if (this.ws) {
      this.ws.removeAllListeners()
      this.ws.close()
      this.ws = null
    }
  }

  private async _connect(): Promise<void> {
    this._cleanup()

    let token: string
    try {
      token = await getAccessToken(this.opts.appId, this.opts.clientSecret)
    } catch (err) {
      console.error("[QQBotWSClient] Failed to get access token:", err)
      this._scheduleReconnect()
      return
    }

    if (!token) {
      console.error("[QQBotWSClient] Empty access token, will retry")
      this._scheduleReconnect()
      return
    }

    const ws = new WebSocket(QQ_WS_URL)
    this.ws = ws

    ws.on("open", () => {
      console.log("[QQBotWSClient] WebSocket connected")
      this.retryCount = 0
    })

    ws.on("message", (data: WebSocket.RawData) => {
      let payload: WSPayload
      try {
        payload = JSON.parse(data.toString()) as WSPayload
      } catch {
        return
      }

      if (payload.s !== undefined) {
        this.lastSeq = payload.s
      }

      this._handlePayload(payload, token)
    })

    ws.on("close", (code, reason) => {
      console.warn(`[QQBotWSClient] WebSocket closed: code=${code} reason=${reason.toString()}`)
      if (!this.stopped) {
        this._scheduleReconnect()
      }
    })

    ws.on("error", (err) => {
      console.error("[QQBotWSClient] WebSocket error:", err)
    })
  }

  private _handlePayload(payload: WSPayload, token: string): void {
    const { op, d, t } = payload

    switch (op) {
      case 10: {
        // Hello — start heartbeat, then identify
        const hello = d as { heartbeat_interval?: number }
        const interval = hello?.heartbeat_interval ?? 30000
        this._startHeartbeat(interval)
        this._identify(token)
        break
      }

      case 0: {
        // Dispatch
        if (t === "READY") {
          const ready = d as { session_id?: string }
          this.sessionId = ready?.session_id ?? null
          console.log(`[QQBotWSClient] READY, session_id=${this.sessionId}`)
        } else if (t === "C2C_MESSAGE_CREATE") {
          void this._handleC2CMessage(d)
        }
        break
      }

      case 7:
        // Reconnect
        console.warn("[QQBotWSClient] op=7 Reconnect requested")
        this._scheduleReconnect()
        break

      case 9:
        // Invalid Session
        console.warn("[QQBotWSClient] op=9 Invalid session, re-identifying")
        this._identify(token)
        break

      case 11:
        // Heartbeat ACK
        break

      default:
        break
    }
  }

  private _startHeartbeat(intervalMs: number): void {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer)
    }
    this.heartbeatTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        const payload: WSPayload = { op: 1, d: this.lastSeq }
        this.ws.send(JSON.stringify(payload))
      }
    }, intervalMs)
  }

  private _identify(token: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return
    const intents = this.opts.intents ?? 1073741824
    const payload = {
      op: 2,
      d: {
        token: `QQBot ${token}`,
        intents,
        shard: [0, 1],
      },
    }
    this.ws.send(JSON.stringify(payload))
  }

  private async _handleC2CMessage(d: unknown): Promise<void> {
    const msg = d as {
      author?: { user_openid?: string; id?: string }
      content?: string
      id?: string
    }
    const openid = msg?.author?.user_openid ?? msg?.author?.id ?? ""
    const content = (msg?.content ?? "").trim()
    const msgId = msg?.id ?? ""

    if (!openid || !content) return

    try {
      const reply = await this.opts.onMessage(openid, content, msgId)
      await sendC2CReply(this.opts.appId, this.opts.clientSecret, openid, reply, msgId)
    } catch (err) {
      console.error("[QQBotWSClient] Failed to handle C2C message:", err)
    }
  }

  private _scheduleReconnect(): void {
    if (this.stopped) return
    if (this.retryCount >= MAX_RETRIES) {
      console.error("[QQBotWSClient] Max retries reached, giving up")
      return
    }
    this.retryCount++
    console.log(`[QQBotWSClient] Reconnecting in ${RETRY_DELAY_MS}ms (attempt ${this.retryCount}/${MAX_RETRIES})`)
    setTimeout(() => {
      if (!this.stopped) {
        void this._connect()
      }
    }, RETRY_DELAY_MS)
  }
}
