// @ts-nocheck
/**
 * gc tui — 交互式 Terminal UI 命令
 *
 * USAGE
 *   gc tui                        # 启动 TUI，新 session
 *   gc tui --session <id>         # 续接已有 session
 *   gc tui --model claude-opus-4  # 指定模型
 */

import type { Command } from "commander"

export function registerTuiCommand(program: Command): void {
  program
    .command("tui")
    .description(
      `Interactive Terminal UI — watch every step of the agent in real time

USAGE
  gc tui                        # start TUI, new session
  gc tui --session <id>         # resume existing session
  gc tui --model <name>         # override model

DISPLAY
  ● RUNNING / ○ IDLE            header status indicator
  TURN N                        current agent turn
  Tool: <name>                  active tool
  ┌─ YOU ──┐                    your message
  ┌─ THINKING ──┐               LLM reasoning / delta text
  ▶ tool_name (Nms) ✓/✗         tool call + result
  ┌─ RESPONSE ──┐               final assistant reply

KEYS
  Enter                         send message
  Ctrl+C / /quit                exit
  /clear                        clear screen
  /session <id>                 switch session
  /help                         show help`,
    )
    .option("-s, --session <id>", "Session ID（续接已有会话）")
    .option("-m, --model <name>", "模型名称（覆盖配置）")
    .action(async (opts) => {
      const { runTui } = await import("../tui/index.js")
      await runTui({
        model: opts.model,
        sessionId: opts.session,
      })
    })
}
