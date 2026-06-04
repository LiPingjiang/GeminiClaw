/**
 * gc tui — 交互式 Terminal UI
 *
 * 功能：
 *  - 清屏，显示 header（状态、turn、工具、session）
 *  - 底部 input bar，raw mode 读取用户输入
 *  - 每次发消息 → POST /v1/agent/stream → 实时渲染 AgentEvent
 *  - Ctrl+C / /quit 退出
 */

import readline from "readline"
import { existsSync, readFileSync } from "fs"
import { join } from "path"
import os from "os"
import yaml from "js-yaml"
import { TuiRenderer, ansi } from "./renderer.js"
import { streamChat } from "./sse-client.js"

// ── 配置加载 ──────────────────────────────────────────────────────────────────

interface ServerConfig {
  baseUrl: string
  authToken?: string
}

function loadServerConfig(): ServerConfig {
  const userCfg = join(os.homedir(), ".gemeniclaw", "config.yaml")
  const cwdCfg = join(process.cwd(), "config.yaml")
  const cfgPath = existsSync(userCfg) ? userCfg : existsSync(cwdCfg) ? cwdCfg : null

  let port = 18888
  let host = "127.0.0.1"
  let authToken: string | undefined

  if (cfgPath) {
    try {
      const raw = yaml.load(readFileSync(cfgPath, "utf-8")) as Record<string, unknown>
      const server = raw?.server as Record<string, unknown> | undefined
      port = (server?.port as number) ?? port
      host = (server?.host as string) ?? host
      authToken = server?.authToken as string | undefined
    } catch { /* ignore */ }
  }

  if (process.env.GC_SERVER_URL) {
    return {
      baseUrl: process.env.GC_SERVER_URL,
      authToken: process.env.GC_AUTH_TOKEN ?? authToken,
    }
  }

  return { baseUrl: `http://${host}:${port}`, authToken }
}

// ── 主 TUI 入口 ───────────────────────────────────────────────────────────────

export interface TuiOptions {
  model?: string
  sessionId?: string
}

export async function runTui(opts: TuiOptions = {}): Promise<void> {
  const srv = loadServerConfig()
  const renderer = new TuiRenderer()

  let currentSessionId = opts.sessionId
  let isRunning = false
  let startMs = 0
  let elapsedTimer: ReturnType<typeof setInterval> | null = null
  let cancelStream: (() => void) | null = null

  // ── 初始化 ──────────────────────────────────────────────────────────────────
  renderer.init()
  renderer.appendEvent({ kind: "system", message: `Connected to ${srv.baseUrl}` })
  if (currentSessionId) {
    renderer.appendEvent({ kind: "system", message: `Session: ${currentSessionId}` })
  }
  renderer.appendEvent({
    kind: "system",
    message: "Type your message and press Enter  |  /quit to exit  |  /help for commands",
  })

  // ── Raw mode 输入 ────────────────────────────────────────────────────────────
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true)
  }
  process.stdin.resume()

  let inputBuffer = ""
  renderer.updateInput("", true)

  // ── 按键处理 ─────────────────────────────────────────────────────────────────
  process.stdin.on("data", async (data: Buffer) => {
    const str = data.toString("utf-8")

    // Ctrl+C
    if (str === "\x03") {
      if (isRunning && cancelStream) {
        cancelStream()
        stopRunning()
        renderer.appendEvent({ kind: "system", message: "Interrupted." })
        return
      }
      cleanup()
      process.exit(0)
    }

    // Enter
    if (str === "\r" || str === "\n") {
      const message = inputBuffer.trim()
      inputBuffer = ""
      renderer.clearInput()

      if (!message) return

      // 内置命令
      if (message === "/quit" || message === "/exit" || message === "/q") {
        cleanup()
        process.exit(0)
      }

      if (message === "/clear") {
        renderer.init()
        renderer.appendEvent({ kind: "system", message: `Connected to ${srv.baseUrl}` })
        return
      }

      if (message.startsWith("/session ")) {
        currentSessionId = message.slice(9).trim()
        renderer.appendEvent({ kind: "system", message: `Session: ${currentSessionId}` })
        return
      }

      if (message === "/help") {
        renderer.appendLines([
          "",
          `  ${ansi.cyan}${ansi.bold}Commands:${ansi.reset}`,
          `    ${ansi.yellow}/quit${ansi.reset}  ${ansi.gray}or${ansi.reset}  ${ansi.yellow}/q${ansi.reset}          exit TUI`,
          `    ${ansi.yellow}/clear${ansi.reset}               clear screen`,
          `    ${ansi.yellow}/session <id>${ansi.reset}        switch session`,
          `    ${ansi.yellow}/help${ansi.reset}                show this help`,
          `    ${ansi.gray}Ctrl+C${ansi.reset}               interrupt running agent`,
          "",
        ])
        return
      }

      if (isRunning) {
        renderer.appendEvent({ kind: "system", message: "Agent is running — press Ctrl+C to interrupt" })
        return
      }

      await sendMessage(message)
      return
    }

    // Backspace
    if (str === "\x7f" || str === "\b") {
      if (inputBuffer.length > 0) {
        inputBuffer = inputBuffer.slice(0, -1)
        renderer.updateInput(inputBuffer, true)
      }
      return
    }

    // 普通可打印字符
    if (str.charCodeAt(0) >= 32 || str.charCodeAt(0) > 127) {
      inputBuffer += str
      renderer.updateInput(inputBuffer, true)
    }
  })

  // ── 发送消息 ──────────────────────────────────────────────────────────────────
  async function sendMessage(message: string): Promise<void> {
    isRunning = true
    startMs = Date.now()

    renderer.appendEvent({ kind: "user_message", content: message })
    renderer.updateHeader({ status: "running", elapsedMs: 0 })

    // 计时器
    elapsedTimer = setInterval(() => {
      renderer.updateHeader({ elapsedMs: Date.now() - startMs })
    }, 500)

    cancelStream = streamChat({
      baseUrl: srv.baseUrl,
      message,
      sessionId: currentSessionId,
      model: opts.model,
      authToken: srv.authToken,
      onEvent: (event) => {
        // 同步更新 header 状态
        if (event.kind === "tool_start") {
          renderer.updateHeader({ currentTool: event.name })
        } else if (event.kind === "tool_end") {
          renderer.updateHeader({ currentTool: undefined })
        } else if (event.kind === "turn_start") {
          renderer.updateHeader({ turn: event.turn })
        }
        renderer.appendEvent(event)
      },
      onSessionId: (sid) => {
        currentSessionId = sid
        renderer.updateHeader({ sessionId: sid })
      },
      onDone: () => {
        stopRunning()
      },
      onError: (err) => {
        stopRunning()
        renderer.appendEvent({ kind: "error", message: err.message })
      },
    })
  }

  function stopRunning(): void {
    isRunning = false
    cancelStream = null
    if (elapsedTimer) {
      clearInterval(elapsedTimer)
      elapsedTimer = null
    }
    renderer.updateHeader({
      status: "idle",
      currentTool: undefined,
      elapsedMs: Date.now() - startMs,
    })
    renderer.updateInput("", true)
  }

  function cleanup(): void {
    if (elapsedTimer) clearInterval(elapsedTimer)
    if (cancelStream) cancelStream()
    renderer.restore()
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(false)
    }
  }

  // ── 信号处理 ──────────────────────────────────────────────────────────────────
  process.on("SIGINT", () => { cleanup(); process.exit(0) })
  process.on("SIGTERM", () => { cleanup(); process.exit(0) })

  // 终端 resize
  process.stdout.on("resize", () => {
    renderer.updateHeader({})
  })

  // ── 阻塞：等待 stdin 关闭 ─────────────────────────────────────────────────────
  const rl = readline.createInterface({ input: process.stdin, terminal: false })
  await new Promise<void>((resolve) => { rl.on("close", resolve) })
}
