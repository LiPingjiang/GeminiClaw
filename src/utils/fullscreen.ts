// src/utils/fullscreen.ts
// Fullscreen / alt-screen environment detection for GeminiClaw's Ink port.

/** Returns true when the terminal supports alt-screen (running interactively in a TTY) */
export function isFullscreenEnvEnabled(): boolean {
  // Explicit opt-out
  if (process.env['CLAUDE_CODE_NO_FLICKER'] === '0' ||
      process.env['CLAUDE_CODE_NO_FLICKER'] === 'false') return false
  // Explicit opt-in
  if (process.env['CLAUDE_CODE_NO_FLICKER'] === '1' ||
      process.env['CLAUDE_CODE_NO_FLICKER'] === 'true') return true
  // Auto: enabled when stdout is a real TTY
  return Boolean(process.stdout.isTTY)
}

/** Returns true when mouse tracking should be enabled */
export function isMouseTrackingEnabled(): boolean {
  return isFullscreenEnvEnabled()
}

export function isMouseClicksDisabled(): boolean { return false }

/** Hint for tmux users — not applicable outside Claude Code context */
export function maybeGetTmuxMouseHint(): Promise<string | undefined> { return Promise.resolve(undefined) }
