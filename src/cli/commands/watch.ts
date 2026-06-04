/**
 * gc watch — 实时监控 QQBot 对话过程
 *
 * 连接 /v1/trace/live SSE 端点，把每个 AgentEvent 渲染到终端。
 * 按 q 或 Ctrl+C 退出。
 *
 * 用法：
 *   gc watch
 *   gc watch --url http://localhost:18790
 *   gc watch --filter <userId>   # 只看某个用户的对话
 */

import type { Command } from "commander"
import * as http from "node:http"
import * as https from "node:https"
import { URL } from "node:url"
import {
  ansi,
  C,
  divider,
  renderHeader,
  wrapText,
  termSize,
  type HeaderState,
} from "../tui/renderer.js"

// ── 默认配置 ──────────────────────────────────────────────────────────────────

const DEFAULT_URL = "http://localhost:18790"

// ── AgentEvent 渲染 ───────────────────────────────────────────────────────────

interface TracePayload {
  ts: number
  userId: string
  sessionId: string
  agentEvent: Record<string, unknown>
}

function fmtTime(ts: number): string {
  const d = new Date(ts)
  const hh = String(d.getHours()).padStart(2, "0")
  const mm = String(d.getMinutes()).padStart(2, "0")
  const ss = String(d.getSeconds()).padStart(2, "0")
  const ms = String(d.getMilliseconds()).padStart(3, "0")
  return `${hh}:${mm}:${ss}.${ms}`
}

function renderTraceEvent(payload: TracePayload): string[] {
  const { ts, userId, sessionId, agentEvent } = payload
  const { cols } = termSize()
  const bodyWidth = cols - 10
  const time = C.dim(fmtTime(ts))
  const who = `${C.label(userId)} ${C.dim("sid:" + sessionId.slice(0, 8))}`
  const type = agentEvent.type as string

  const lines: string[] = []

  switch (type) {
    case "turn_start": {
      lines.push("")
      lines.push(divider(`TURN  ${time}  ${who}`))
      lines.push("")
      break
    }

    case "turn_end": {
      // 静默，turn_start 已经标记了
      break
    }

    case "tool_start": {
      const name = String(agentEvent.toolName ?? "?")
      const args = agentEvent.args ?? {}
      const argsStr = JSON.stringify(args, null, 2)
      const preview = argsStr.length > 500 ? argsStr.slice(0, 500) + "…" : argsStr
      lines.push(`  ${time} ${C.tool("▶ TOOL")} ${ansi.bold}${C.tool(name)}${ansi.reset}`)
      for (const l of wrapText(preview, bodyWidth)) {
        lines.push(`    ${C.dim(l)}`)
      }
      break
    }

    case "tool_end": {
      const name = String(agentEvent.toolName ?? "?")
      const result = agentEvent.result as { content?: string; isError?: boolean } | undefined
      const isError = result?.isError ?? false
      const content = String(result?.content ?? "")
      const preview = content.length > 600 ? content.slice(0, 600) + "…" : content
      const icon = isError ? C.error("✗") : C.success("✓")
      lines.push(`  ${time} ${C.tool("◀ TOOL")} ${ansi.bold}${C.tool(name)}${ansi.reset} ${icon}`)
      for (const l of wrapText(preview, bodyWidth)) {
        lines.push(`    ${C.dim(l)}`)
      }
      break
    }

    case "message_delta": {
      const delta = String(agentEvent.delta ?? "")
      if (delta.trim()) {
        lines.push(`  ${time} ${C.llm("△ DELTA")} ${C.dim(delta.slice(0, 200))}`)
      }
      break
    }

    case "agent_end": {
      const stopReason = String(agentEvent.stopReason ?? "done")
      const totalTurns = Number(agentEvent.totalTurns ?? 0)
      const icon = stopReason === "no_tool_calls" ? C.success("✓") : C.warn("⚠")
      lines.push("")
      lines.push(`  ${time} ${icon} ${C.dim(`DONE — ${totalTurns} turns, ${stopReason}`)}  ${who}`)
      lines.push(divider())
      lines.push("")
      break
    }

    case "guardrail_warn": {
      const toolName = String(agentEvent.toolName ?? "?")
      const msg = String(agentEvent.message ?? "")
      lines.push(`  ${time} ${C.warn("⚠ GUARDRAIL")} [${toolName}] ${msg}`)
      break
    }

    case "guardrail_halt": {
      const toolName = String(agentEvent.toolName ?? "?")
      const msg = String(agentEvent.message ?? "")
      lines.push(`  ${time} ${C.error("✗ HALT")} [${toolName}] ${msg}`)
      break
    }

    default: {
      // 未知事件类型：dim 显示
      lines.push(`  ${time} ${C.dim(type)} ${C.dim(JSON.stringify(agentEvent).slice(0, 120))}`)
      break
    }
  }

  return lines
}

// ── SSE 客户端 ────────────────────────────────────────────────────────────────

function connectSSE(
  url: string,
  onEvent: (payload: TracePayload) => void,
  onError: (err: Error) => void,
  onConnected: () => void,
): () => void {
  const parsed = new URL(url)
  const lib = parsed.protocol === "https:" ? https : http

  let destroyed = false
  let req: http.ClientRequest | null = null

  const connect = () => {
    if (destroyed) return

    req = lib.request(
      {
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method: "GET",
        headers: { Accept: "text/event-stream" },
      },
      (res) => {
        if (res.statusCode !== 200) {
          onError(new Error(`HTTP ${res.statusCode}`))
          return
        }
        onConnected()

        let buf = ""
        res.setEncoding("utf8")
        res.on("data", (chunk: string) => {
          buf += chunk
          const parts = buf.split("\n\n")
          buf = parts.pop() ?? ""
          for (const part of parts) {
            for (const line of part.split("\n")) {
              if (line.startsWith("data: ")) {
                try {
                  const payload = JSON.parse(line.slice(6)) as TracePayload
                  onEvent(payload)
                } catch {
                  // ignore parse errors
                }
              }
            }
          }
        })
        res.on("end", () => {
          if (!destroyed) {
            // 自动重连（2s 后）
            setTimeout(connect, 2000)
          }
        })
      },
    )

    req.on("error", (err) => {
      if (!destroyed) {
        onError(err)
        setTimeout(connect, 3000)
      }
    })

    req.end()
  }

  connect()

  return () => {
    destroyed = true
    req?.destroy()
  }
}

// ── 主命令 ────────────────────────────────────────────────────────────────────

export function registerWatchCommand(program: Command): void {
  program
    .command("watch")
    .description("实时监控 QQBot 对话过程（工具调用、LLM 输入输出）")
    .option("--url <url>", "GeminiClaw 服务地址", DEFAULT_URL)
    .option("--filter <userId>", "只显示指定用户的对话（前缀匹配）")
    .action(async (opts: { url: string; filter?: string }) => {
      const sseUrl = opts.url.replace(/\/$/, "") + "/v1/trace/live"
      const filter = opts.filter

      // ── 初始化 TUI ──────────────────────────────────────────────────────
      process.stdout.write(ansi.clearScreen)
      process.stdout.write(ansi.hideCursor)

      const headerState: HeaderState = {
        status: "idle",
        sessionId: "watch",
        model: "live",
      }
      process.stdout.write(renderHeader(headerState) + "\n")
      process.stdout.write(divider() + "\n")
      process.stdout.write(
        `  ${C.dim("Connecting to")} ${C.label(sseUrl)} ${C.dim("…")}\n`,
      )
      if (filter) {
        process.stdout.write(`  ${C.dim("Filter:")} ${C.label(filter)}\n`)
      }
      process.stdout.write(`  ${C.dim("Press")} ${C.bold("q")} ${C.dim("or")} ${C.bold("Ctrl+C")} ${C.dim("to exit")}\n`)
      process.stdout.write(divider() + "\n")

      // ── 键盘输入（raw mode，q 退出） ────────────────────────────────────
      let cleanup: (() => void) | null = null

      const exit = () => {
        process.stdout.write(ansi.showCursor)
        process.stdout.write("\n")
        cleanup?.()
        process.exit(0)
      }

      if (process.stdin.isTTY) {
        process.stdin.setRawMode(true)
        process.stdin.resume()
        process.stdin.setEncoding("utf8")
        process.stdin.on("data", (key: string) => {
          if (key === "q" || key === "\x03" /* Ctrl+C */) {
            exit()
          }
        })
      }

      process.on("SIGINT", exit)
      process.on("SIGTERM", exit)

      // ── 连接 SSE ────────────────────────────────────────────────────────
      let connected = false

      const disconnect = connectSSE(
        sseUrl,
        (payload) => {
          // 过滤
          if (filter && !payload.userId.startsWith(filter)) return

          const lines = renderTraceEvent(payload)
          if (lines.length === 0) return

          // 更新 header
          const evType = payload.agentEvent.type as string
          const isRunning = evType !== "agent_end"
          headerState.status = isRunning ? "running" : "idle"
          if (evType === "tool_start") {
            headerState.currentTool = String(payload.agentEvent.toolName ?? "")
          } else if (evType === "agent_end" || evType === "turn_start") {
            headerState.currentTool = undefined
          }
          headerState.sessionId = payload.sessionId.slice(0, 8)

          // 重绘 header（第1行）
          process.stdout.write(ansi.saveCursor)
          process.stdout.write(ansi.cursorPos(1, 1))
          process.stdout.write(renderHeader(headerState))
          process.stdout.write(ansi.restoreCursor)

          // 追加事件行
          for (const line of lines) {
            process.stdout.write(line + "\n")
          }
        },
        (err) => {
          if (!connected) {
            process.stdout.write(
              `  ${C.error("✗")} ${C.error("连接失败：")} ${C.dim(err.message)}\n`,
            )
            process.stdout.write(
              `  ${C.dim("3s 后重试…")}\n`,
            )
          } else {
            process.stdout.write(
              `  ${C.warn("⚠")} ${C.warn("连接断开，重连中…")}\n`,
            )
          }
        },
        () => {
          connected = true
          headerState.status = "running"
          process.stdout.write(ansi.saveCursor)
          process.stdout.write(ansi.cursorPos(1, 1))
          process.stdout.write(renderHeader(headerState))
          process.stdout.write(ansi.restoreCursor)
          process.stdout.write(
            `  ${C.success("✓")} ${C.dim("已连接，等待 QQBot 对话事件…")}\n`,
          )
        },
      )

      cleanup = disconnect

      // 保持进程存活
      await new Promise<void>(() => {/* never resolves */})
    })
}
