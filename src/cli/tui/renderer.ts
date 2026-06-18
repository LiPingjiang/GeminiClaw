/**
 * TUI Renderer utilities — retained for watch.ts compatibility
 */

export const ansi = {
  reset:     "\x1b[0m",
  bold:      "\x1b[1m",
  dim:       "\x1b[2m",
  italic:    "\x1b[3m",
  underline: "\x1b[4m",
  black:   "\x1b[30m",
  red:     "\x1b[31m",
  green:   "\x1b[32m",
  yellow:  "\x1b[33m",
  blue:    "\x1b[34m",
  magenta: "\x1b[35m",
  cyan:    "\x1b[36m",
  white:   "\x1b[37m",
  gray:    "\x1b[90m",
  brightRed:     "\x1b[91m",
  brightGreen:   "\x1b[92m",
  brightYellow:  "\x1b[93m",
  brightBlue:    "\x1b[94m",
  brightMagenta: "\x1b[95m",
  brightCyan:    "\x1b[96m",
  brightWhite:   "\x1b[97m",
  bgBlack:   "\x1b[40m",
  bgGray:    "\x1b[100m",
  clearLine:     "\x1b[2K",
  cursorPos:     (row: number, col: number) => `\x1b[${row};${col}H`,
  saveCursor:    "\x1b[s",
  restoreCursor: "\x1b[u",
  hideCursor:    "\x1b[?25l",
  showCursor:    "\x1b[?25h",
  clearScreen:   "\x1b[2J\x1b[H",
}

export function visibleLen(s: string): number {
  return s.replace(/\x1b\[[0-9;]*m/g, "").length
}

export function pad(s: string, width: number): string {
  const vl = visibleLen(s)
  if (vl >= width) return s
  return s + " ".repeat(width - vl)
}

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

export function termSize(): { cols: number; rows: number } {
  return {
    cols: process.stdout.columns ?? 120,
    rows: process.stdout.rows ?? 40,
  }
}

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

export function divider(label?: string): string {
  const { cols } = termSize()
  if (!label) return C.border("─".repeat(cols))
  const side = Math.max(0, Math.floor((cols - label.length - 2) / 2))
  return C.border("─".repeat(side)) + " " + C.label(label) + " " + C.border("─".repeat(Math.max(0, cols - side - label.length - 2)))
}

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

export type TuiEvent = never; // kept for type compatibility
