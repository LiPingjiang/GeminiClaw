/**
 * SSE Client — 消费 /v1/agent/stream 流
 *
 * 直接 POST 消息，服务端以 SSE 推回 AgentLoop 原生事件（AgentEvent）。
 * 纯 Node.js http/https，零外部依赖。
 */

import http from "http"
import https from "https"
import type { TuiEvent } from "./types.js"

// ── AgentEvent 类型（与 src/agent/types.ts 对应） ─────────────────────────────

interface AgentEvent {
  type: string
  // turn_start
  turn?: number
  // message_delta
  delta?: string
  // turn_end
  message?: { role: string; content: string }
  toolCallCount?: number
  // tool_start / tool_end
  toolCallId?: string
  toolName?: string
  args?: unknown
  result?: { content: string; isError?: boolean }
  isError?: boolean
  durationMs?: number
  // agent_end
  totalTurns?: number
  stopReason?: string
  model?: string
  usage?: { inputTokens: number; outputTokens: number; cacheReadInputTokens?: number; cacheCreationInputTokens?: number }
  // paused
  pauseId?: string
  payload?: unknown
  // error
  error?: string
}

// ── SSE 解析器 ────────────────────────────────────────────────────────────────

type SseCallback = (eventType: string, data: string) => void

function parseSseStream(
  stream: NodeJS.ReadableStream,
  onEvent: SseCallback,
  onEnd: () => void,
  onError: (err: Error) => void,
): void {
  let buffer = ""
  let currentEvent = "message"

  stream.setEncoding("utf-8")

  stream.on("data", (chunk: string) => {
    buffer += chunk
    const lines = buffer.split("\n")
    buffer = lines.pop() ?? ""

    for (const line of lines) {
      if (line.startsWith("event:")) {
        currentEvent = line.slice(6).trim()
      } else if (line.startsWith("data:")) {
        const data = line.slice(5).trim()
        onEvent(currentEvent, data)
        currentEvent = "message"
      } else if (line === "") {
        currentEvent = "message"
      }
    }
  })

  stream.on("end", onEnd)
  stream.on("error", onError)
}

// ── AgentEvent → TuiEvent 转换 ────────────────────────────────────────────────

function translateAgentEvent(raw: AgentEvent): TuiEvent | null {
  switch (raw.type) {
    case "turn_start":
      return { kind: "turn_start", turn: raw.turn ?? 0 }

    case "message_delta":
      return { kind: "delta", content: raw.delta ?? "" }

    case "turn_end":
      return { kind: "turn_end", toolCallCount: raw.toolCallCount ?? 0 }

    case "tool_start":
      return {
        kind: "tool_start",
        name: raw.toolName ?? "unknown",
        args: raw.args ?? {},
      }

    case "tool_end":
      return {
        kind: "tool_end",
        name: raw.toolName ?? "unknown",
        durationMs: raw.durationMs ?? 0,
        isError: raw.isError ?? false,
        result: raw.result?.content ?? "",
      }

    case "agent_end":
      return {
        kind: "agent_end",
        totalTurns: raw.totalTurns ?? 0,
        stopReason: raw.stopReason ?? "unknown",
        model: raw.model,
        usage: raw.usage,
      }

    case "guardrail_warn":
      return {
        kind: "guardrail_warn",
        toolName: raw.toolName ?? "",
        message: (raw as { message?: string }).message ?? "",
      }

    case "guardrail_halt":
      return {
        kind: "guardrail_halt",
        toolName: raw.toolName ?? "",
        message: (raw as { message?: string }).message ?? "",
      }

    case "thinking_delta":
      return { kind: "thinking_delta", delta: raw.delta ?? "" }

    case "thinking_end":
      return { kind: "thinking_end", content: (raw as { content?: string }).content ?? "", durationMs: raw.durationMs ?? 0 }

    default:
      return null
  }
}

// ── 主函数：POST 消息并订阅 SSE 流 ───────────────────────────────────────────

export interface StreamOptions {
  baseUrl: string
  message: string
  sessionId?: string
  model?: string
  authToken?: string
  onEvent: (event: TuiEvent) => void
  onSessionId: (sessionId: string) => void
  onDone: () => void
  onError: (err: Error) => void
}

export function streamChat(opts: StreamOptions): () => void {
  const { baseUrl, message, sessionId, model, authToken, onEvent, onSessionId, onDone, onError } = opts
  const url = new URL("/v1/agent/stream", baseUrl)
  const transport = url.protocol === "https:" ? https : http

  const body = JSON.stringify({ message, sessionId, model })

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body).toString(),
    "Accept": "text/event-stream",
    "Cache-Control": "no-cache",
  }
  if (authToken) headers["Authorization"] = `Bearer ${authToken}`

  // Track state to prevent duplicate done/error callbacks and status overwrites
  let errorOccurred = false
  let doneCalled = false

  const handleDone = (): void => {
    // Do not fire onDone if an error already occurred (prevents status overwrite),
    // and deduplicate: only call onDone once (handles both [DONE] data and stream end).
    if (errorOccurred || doneCalled) return
    doneCalled = true
    onDone()
  }

  const handleError = (err: Error): void => {
    if (doneCalled) return
    errorOccurred = true
    onError(err)
  }

  const req = transport.request(
    {
      hostname: url.hostname,
      port: url.port || (url.protocol === "https:" ? 443 : 80),
      path: url.pathname,
      method: "POST",
      headers,
    },
    (res) => {
      if (res.statusCode !== 200) {
        let errBody = ""
        res.setEncoding("utf-8")
        res.on("data", (c: string) => { errBody += c })
        res.on("end", () => {
          handleError(new Error(`HTTP ${res.statusCode}: ${errBody}`))
        })
        return
      }

      parseSseStream(
        res,
        (eventType, data) => {
          if (data === "[DONE]") {
            handleDone()
            return
          }

          if (eventType === "done") {
            try {
              const parsed = JSON.parse(data) as { sessionId?: string }
              if (parsed.sessionId) onSessionId(parsed.sessionId)
            } catch { /* ignore */ }
            return
          }

          if (eventType === "error") {
            try {
              const parsed = JSON.parse(data) as { error?: string }
              handleError(new Error(parsed.error ?? "unknown stream error"))
            } catch {
              handleError(new Error(data))
            }
            return
          }

          if (eventType !== "agent_event") return

          try {
            const raw = JSON.parse(data) as AgentEvent
            const tuiEvent = translateAgentEvent(raw)
            if (tuiEvent) onEvent(tuiEvent)
          } catch { /* ignore parse errors */ }
        },
        () => {
          // Stream ended — fire onDone only if no error occurred and not already done
          handleDone()
        },
        handleError,
      )
    },
  )

  req.on("error", handleError)
  req.write(body)
  req.end()

  return () => req.destroy()
}
