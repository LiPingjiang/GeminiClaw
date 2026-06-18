// @ts-nocheck
/**
 * gc tui — interactive Terminal UI
 *
 * USAGE
 *   gc tui                        # auto-resume last session (or new if none)
 *   gc tui --new                  # force new session
 *   gc tui --session <id>         # resume specific session
 *   gc tui --model <name>         # override model
 */

import type { Command } from 'commander'
export { getLastSessionId, saveLastSessionId } from '../tui/session-store.js'

export function registerTuiCommand(program: Command): void {
  program
    .command('tui')
    .description('Interactive Terminal UI — watch every step of the agent in real time')
    .option('-s, --session <id>', 'Resume specific session by ID')
    .option('-m, --model <name>', 'Override model name')
    .option('--new', 'Force new session (ignore last-session)')
    .action(async (opts) => {
      let sessionId = opts.session
      if (!sessionId && !opts.new) {
        const { getLastSessionId } = await import('../tui/session-store.js')
        sessionId = getLastSessionId()
      }
      const { runTui } = await import('../tui/index.js')
      await runTui({ model: opts.model, sessionId })
    })
}
