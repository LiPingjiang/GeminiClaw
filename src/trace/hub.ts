/**
 * TraceHub — 全局单例事件总线
 *
 * QQBotChannel 在处理每条消息时，把 AgentLoop 产生的每个 AgentEvent
 * 连同上下文（userId、sessionId）一起 emit 到这里。
 *
 * /v1/trace/live SSE 端点订阅 TraceHub，把事件实时推给 gc watch。
 */

import { EventEmitter } from "events"

// ── 事件类型 ──────────────────────────────────────────────────────────────────

export interface TraceEvent {
  /** 事件时间戳（ms） */
  ts: number
  /** QQ 用户 openid（脱敏：只保留前8位 + "..."） */
  userId: string
  /** session id */
  sessionId: string
  /** 原始 AgentEvent（序列化为普通对象） */
  agentEvent: Record<string, unknown>
}

// ── 单例 ──────────────────────────────────────────────────────────────────────

class TraceHub extends EventEmitter {
  private static _instance: TraceHub | null = null

  private constructor() {
    super()
    this.setMaxListeners(100) // 支持多个 gc watch 同时连接
  }

  static get instance(): TraceHub {
    if (!TraceHub._instance) {
      TraceHub._instance = new TraceHub()
    }
    return TraceHub._instance
  }

  /** 发布一个 trace 事件 */
  publish(event: TraceEvent): void {
    this.emit("trace", event)
  }

  /** 订阅 trace 事件，返回取消函数 */
  subscribe(listener: (event: TraceEvent) => void): () => void {
    this.on("trace", listener)
    return () => this.off("trace", listener)
  }
}

export const traceHub = TraceHub.instance
