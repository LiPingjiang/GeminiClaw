/**
 * TUI Renderer — 纯 ANSI 转义码，零外部依赖
 *
 * 负责：
 *  - 终端尺寸感知
 *  - 颜色/样式原语
 *  - 三区域布局（header / scroll-body / input-bar）
 *  - 增量追加（不整屏重绘，只追加新行）
 */

// ── ANSI 原语 ─────────────────────────────────────────────────────────────────

export const ansi = {
  reset:     "\x1b[0m",
  bold:      "\x1b[1m",
  dim:       "\x1b[2m",
  italic:    "\x1b[3m",
  underline: "\x1b[4m",

  // 前景色
  black:   "\x1b[30m",
  red:     "\x1b[31m",
  green:   "\x1b[32m",
  yellow:  "\x1b[33m",
  blue:    "\x1b[34m",
  magenta: "\x1b[35m",
  cyan:    "\x1b[36m",
  white:   "\x1b[37m",
  gray:    "\x1b[90m",

  // 亮色前景
  brightRed:     "\x1b[91m",
  brightGreen:   "\x1b[92m",
  brightYellow:  "\x1b[93m",
  brightBlue:    "\x1b[94m",
  brightMagenta: "\x1b[95m",
  brightCyan:    "\x1b[96m",
  brightWhite:   "\x1b[97m",

  // 背景色
  bgBlack:   "\x1b[40m",
  bgGray:    "\x1b[100m",

  // 光标控制
  clearLine:     "\x1b[2K",
  cursorPos:     (row: number, col: number) => `\x1b[${row};${col}H`,
  saveCursor:    "\x1b[s",
  restoreCursor: "\x1b[u",
  hideCursor:    "\x1b[?25l",
  showCursor:    "\x1b[?25h",
  clearScreen:   "\x1b[2J\x1b[H",
}

// ── 工具函数 ──────────────────────────────────────────────────────────────────

/** 去掉 ANSI 转义码，计算可见字符宽度 */
export function visibleLen(s: string): number {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "").length
}

/** 用空格填充到指定可见宽度 */
export function pad(s: string, width: number): string {
  const vl = visibleLen(s)
  if (vl >= width) return s
  return s + " ".repeat(width - vl)
}

/** 将长文本按宽度折行，返回行数组 */
export function wrapText(text: string, width: number): string[] {
  if (width <= 4) return [text]
  const lines: string[] = []
  for (const para of text.split("\n")) {
    if (para.length === 0) { lines.push(""); continue }
    let remaining = para
    while (remaining.length > 0) {
      lines.push(remaining.slice(0, width))
      remaining = remaining.slice(width)
    }
  }
  return lines
}

/** 获取终端尺寸 */
export function termSize(): { cols: number; rows: number } {
  return {
    cols: process.stdout.columns ?? 120,
    rows: process.stdout.rows ?? 40,
  }
}

// ── 颜色语义别名 ──────────────────────────────────────────────────────────────

export const C = {
  running:  (s: string) => `${ansi.brightGreen}${ansi.bold}${s}${ansi.reset}`,
  idle:     (s: string) => `${ansi.gray}${s}${ansi.reset}`,
  error:    (s: string) => `${ansi.brightRed}${s}${ansi.reset}`,
  warn:     (s: string) => `${ansi.brightYellow}${s}${ansi.reset}`,
  success:  (s: string) => `${ansi.brightGreen}${s}${ansi.reset}`,
  label:    (s: string) => `${ansi.cyan}${ansi.bold}${s}${ansi.reset}`,
  dim:      (s: string) => `${ansi.gray}${s}${ansi.reset}`,
  bold:     (s: string) => `${ansi.bold}${s}${ansi.reset}`,
  tool:     (s: string) => `${ansi.brightMagenta}${s}${ansi.reset}`,
  llm:      (s: string) => `${ansi.brightBlue}${s}${ansi.reset}`,
  thinking: (s: string) => `${ansi.italic}${ansi.cyan}${s}${ansi.reset}`,
  response: (s: string) => `${ansi.brightWhite}${s}${ansi.reset}`,
  user:     (s: string) => `${ansi.brightYellow}${s}${ansi.reset}`,
  system:   (s: string) => `${ansi.gray}${s}${ansi.reset}`,
  border:   (s: string) => `${ansi.gray}${s}${ansi.reset}`,
}

// ── 盒子绘制 ──────────────────────────────────────────────────────────────────

export interface BoxOptions {
  title?: string
  titleColor?: (s: string) => string
  indent?: number
}

/** 绘制一个带标题的内容盒子，返回行数组 */
export function box(lines: string[], opts: BoxOptions = {}): string[] {
  const { cols } = termSize()
  const indent = opts.indent ?? 2
  const width = cols - indent * 2 - 2
  const bc = C.border
  const tc = opts.titleColor ?? C.label
  const indentStr = " ".repeat(indent)

  const topBorder = opts.title
    ? bc("┌─ ") + tc(opts.title) + bc(" " + "─".repeat(Math.max(0, width - opts.title.length - 4)) + "┐")
    : bc("┌" + "─".repeat(width) + "┐")

  const result: string[] = [indentStr + topBorder]
  for (const line of lines) {
    const wrapped = wrapText(line, width - 2)
    for (const wl of wrapped) {
      result.push(indentStr + bc("│") + " " + pad(wl, width - 2) + bc("│"))
    }
  }
  result.push(indentStr + bc("└" + "─".repeat(width) + "┘"))
  return result
}

// ── 分隔线 ────────────────────────────────────────────────────────────────────

export function divider(label?: string): string {
  const { cols } = termSize()
  if (!label) return C.border("─".repeat(cols))
  const side = Math.max(0, Math.floor((cols - label.length - 2) / 2))
  return C.border("─".repeat(side)) + " " + C.label(label) + " " + C.border("─".repeat(Math.max(0, cols - side - label.length - 2)))
}

// ── Header 行 ─────────────────────────────────────────────────────────────────

export interface HeaderState {
  status: "idle" | "running" | "error"
  turn?: number
  maxTurns?: number
  currentTool?: string
  sessionId?: string
  model?: string
  elapsedMs?: number
}

export function renderHeader(state: HeaderState): string {
  const { cols } = termSize()

  const statusIcon = state.status === "running"
    ? `${ansi.brightGreen}●${ansi.reset}`
    : state.status === "error"
    ? `${ansi.brightRed}●${ansi.reset}`
    : `${ansi.gray}○${ansi.reset}`

  const statusText = state.status === "running"
    ? C.running("RUNNING")
    : state.status === "error"
    ? C.error("ERROR")
    : C.idle("IDLE")

  const left = ` ${ansi.bold}${ansi.brightCyan}GeminiClaw${ansi.reset}${ansi.bgGray} `
  const rightParts: string[] = []

  if (state.turn !== undefined && state.maxTurns !== undefined) {
    rightParts.push(C.dim(`Turn ${state.turn}/${state.maxTurns}`))
  }
  if (state.currentTool) {
    rightParts.push(`${C.dim("Tool:")} ${C.tool(state.currentTool)}`)
  }
  if (state.model) {
    rightParts.push(C.dim(state.model))
  }
  if (state.sessionId) {
    rightParts.push(C.dim(`sid:${state.sessionId.slice(0, 8)}`))
  }
  if (state.elapsedMs !== undefined) {
    rightParts.push(C.dim(`${(state.elapsedMs / 1000).toFixed(1)}s`))
  }

  const right = rightParts.join(C.dim("  │  ")) + `  ${statusIcon} ${statusText} `

  const leftLen = visibleLen(left)
  const rightLen = visibleLen(right)
  const gap = Math.max(1, cols - leftLen - rightLen)

  return `${ansi.bgGray}${left}${" ".repeat(gap)}${right}${ansi.reset}`
}

// ── Input Bar ─────────────────────────────────────────────────────────────────

export function renderInputBar(prompt: string, input: string, active: boolean): string {
  const { cols } = termSize()
  const promptStr = active
    ? `${ansi.brightYellow}${ansi.bold}${prompt}${ansi.reset} `
    : `${ansi.gray}${prompt}${ansi.reset} `
  const cursor = active ? `${ansi.brightWhite}█${ansi.reset}` : ""
  const line = promptStr + input + cursor
  return `${ansi.bgBlack}${pad(line, cols)}${ansi.reset}`
}

// ── 事件类型 ──────────────────────────────────────────────────────────────────

export type TuiEvent =
  | { kind: "turn_start"; turn: number }
  | { kind: "llm_input"; messages: Array<{ role: string; content: string }> }
  | { kind: "thinking"; content: string }
  | { kind: "tool_start"; name: string; args: unknown }
  | { kind: "tool_end"; name: string; durationMs: number; isError: boolean; result: string }
  | { kind: "response"; content: string }
  | { kind: "user_message"; content: string }
  | { kind: "agent_end"; totalTurns: number; stopReason: string }
  | { kind: "error"; message: string }
  | { kind: "guardrail_warn"; toolName: string; message: string }
  | { kind: "guardrail_halt"; toolName: string; message: string }
  | { kind: "system"; message: string }

/** 将一个 TuiEvent 渲染为若干行字符串 */
export function renderEvent(event: TuiEvent): string[] {
  const { cols } = termSize()
  const bodyWidth = cols - 8

  switch (event.kind) {
    case "turn_start":
      return ["", divider(`TURN ${event.turn}`), ""]

    case "user_message":
      return box(wrapText(event.content, bodyWidth), { title: "YOU", titleColor: C.user, indent: 2 })

    case "llm_input": {
      const lines: string[] = []
      for (const m of event.messages) {
        const preview = m.content.slice(0, 300) + (m.content.length > 300 ? "…" : "")
        lines.push(`${C.dim(m.role + ":")} ${preview}`)
      }
      return box(lines, { title: "LLM INPUT", titleColor: C.llm, indent: 2 })
    }

    case "thinking":
      return box(wrapText(event.content, bodyWidth), { title: "THINKING", titleColor: C.thinking, indent: 2 })

    case "tool_start": {
      const argsStr = JSON.stringify(event.args, null, 2)
      const preview = argsStr.length > 400 ? argsStr.slice(0, 400) + "…" : argsStr
      return [
        `  ${C.tool("▶")} ${ansi.bold}${C.tool(event.name)}${ansi.reset} ${C.dim("…")}`,
        ...wrapText(preview, bodyWidth).map(l => `    ${C.dim(l)}`),
      ]
    }

    case "tool_end": {
      const icon = event.isError ? C.error("✗") : C.success("✓")
      const dur = C.dim(`(${event.durationMs}ms)`)
      const header = `  ${C.tool("▶")} ${ansi.bold}${C.tool(event.name)}${ansi.reset} ${dur} ${icon}`
      const resultPreview = event.result.slice(0, 600) + (event.result.length > 600 ? "…" : "")
      return [header, ...wrapText(resultPreview, bodyWidth).map(l => `    ${C.dim(l)}`)]
    }

    case "response":
      return ["", ...box(wrapText(event.content, bodyWidth), { title: "RESPONSE", titleColor: C.response, indent: 2 }), ""]

    case "agent_end": {
      const icon = event.stopReason === "no_tool_calls" ? C.success("✓") : C.warn("⚠")
      return ["", `  ${icon} ${C.dim(`Done — ${event.totalTurns} turns, ${event.stopReason}`)}`, "", divider()]
    }

    case "error":
      return ["", `  ${C.error("✗ ERROR:")} ${C.error(event.message)}`, ""]

    case "guardrail_warn":
      return [`  ${C.warn("⚠ GUARDRAIL")} [${event.toolName}] ${event.message}`]

    case "guardrail_halt":
      return [`  ${C.error("✗ HALT")} [${event.toolName}] ${event.message}`]

    case "system":
      return [`  ${C.system("ℹ " + event.message)}`]
  }
}

// ── 主渲染器类 ────────────────────────────────────────────────────────────────

export class TuiRenderer {
  private out: NodeJS.WriteStream
  private headerState: HeaderState = { status: "idle" }
  private inputLine = ""
  private inputActive = false
  private readonly inputPrompt = ">"

  constructor(out: NodeJS.WriteStream = process.stdout) {
    this.out = out
  }

  /** 初始化：清屏，绘制 header + input bar */
  init(): void {
    this.out.write(ansi.hideCursor)
    this.out.write(ansi.clearScreen)
    this.out.write(renderHeader(this.headerState) + "\n")
    this.out.write(divider() + "\n")
    this._redrawInputBar()
  }

  /** 更新 header 状态（重绘第1行） */
  updateHeader(state: Partial<HeaderState>): void {
    this.headerState = { ...this.headerState, ...state }
    this.out.write(ansi.saveCursor)
    this.out.write(ansi.cursorPos(1, 1))
    this.out.write(renderHeader(this.headerState))
    this.out.write(ansi.restoreCursor)
  }

  /** 追加一个 TuiEvent（在 input bar 上方插入行） */
  appendEvent(event: TuiEvent): void {
    this._insertLines(renderEvent(event))
  }

  /** 追加纯文本行 */
  appendLines(lines: string[]): void {
    this._insertLines(lines)
  }

  /** 更新输入框内容 */
  updateInput(text: string, active = true): void {
    this.inputLine = text
    this.inputActive = active
    this._redrawInputBar()
  }

  /** 清空输入框 */
  clearInput(): void {
    this.inputLine = ""
    this._redrawInputBar()
  }

  /** 恢复终端（退出时调用） */
  restore(): void {
    this.out.write(ansi.showCursor)
    this.out.write("\n")
  }

  // ── 私有 ──────────────────────────────────────────────────────────────────

  private _redrawInputBar(): void {
    this.out.write("\r" + ansi.clearLine)
    this.out.write(renderInputBar(this.inputPrompt, this.inputLine, this.inputActive))
    this.out.write("\r")
  }

  private _insertLines(lines: string[]): void {
    // 清 input bar 行 → 写内容 → 重绘 input bar
    this.out.write("\r" + ansi.clearLine)
    for (const line of lines) {
      this.out.write(line + "\n")
    }
    this._redrawInputBar()
  }
}
