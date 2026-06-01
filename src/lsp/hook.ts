/**
 * src/lsp/hook.ts
 * Registers LSP diagnostics as hooks on the HookBus.
 *
 * Strategy:
 *  - pre_tool_call (for write/edit): snapshot baseline diagnostics
 *  - post_tool_call (for write/edit): compute diff, log new errors
 *
 * The actual result mutation (appending diagnostics to tool output)
 * is handled via AgentLoop's afterToolCall callback, which this hook
 * coordinates with.
 */

import { hookBus } from "../hooks/index.js"
import { snapshotBaseline, getDiagnosticsDiff, formatDiagnostics } from "./index.js"
import type { PreToolCallPayload, PostToolCallPayload } from "../hooks/index.js"

const FILE_WRITE_TOOLS = new Set(["write", "edit", "file_write", "fuzzy_edit"])

export interface LspHookOptions {
  /** Working directory for tsc execution */
  workdir?: string
  /** Disable LSP hooks entirely */
  disabled?: boolean
}

/**
 * Register LSP diagnostic hooks on the global HookBus.
 * Returns unsubscribe function.
 */
export function registerLspHooks(options?: LspHookOptions): () => void {
  if (options?.disabled) return () => {}

  const workdir = options?.workdir
  const unsubs: Array<() => void> = []

  // ── pre_tool_call: snapshot baseline before file writes ──────────────────
  const unsubPre = hookBus.on(
    "pre_tool_call",
    async (payload: PreToolCallPayload) => {
      if (!FILE_WRITE_TOOLS.has(payload.toolName)) return undefined

      const filePath = extractFilePath(payload.args)
      if (!filePath) return undefined
      if (!isTypeScriptPath(filePath)) return undefined

      // Snapshot current errors before the write happens
      await snapshotBaseline(filePath, workdir)
      return undefined
    },
    // Priority 50: after security (10-11) but before general hooks
    50,
  )
  unsubs.push(unsubPre)

  // ── post_tool_call: check for new errors after file writes ──────────────
  const unsubPost = hookBus.on(
    "post_tool_call",
    async (payload: PostToolCallPayload) => {
      if (!FILE_WRITE_TOOLS.has(payload.toolName)) return undefined
      // Don't check if the tool itself errored
      if (payload.result.isError) return undefined

      const filePath = extractFilePath(payload.args)
      if (!filePath) return undefined
      if (!isTypeScriptPath(filePath)) return undefined

      const diff = await getDiagnosticsDiff(filePath, workdir)
      const formatted = formatDiagnostics(diff)

      if (formatted) {
        console.log(
          `[LSP] ${diff.newErrors.length} new TypeScript error(s) in ${filePath}`
        )
        // Return the formatted diagnostics — consumers can use this
        // to append to tool results via afterToolCall
        return { diagnostics: formatted, newErrorCount: diff.newErrors.length }
      }

      if (diff.resolvedErrors.length > 0) {
        console.log(
          `[LSP] ✓ ${diff.resolvedErrors.length} error(s) resolved in ${filePath}`
        )
      }

      return undefined
    },
    50,
  )
  unsubs.push(unsubPost)

  return () => {
    for (const unsub of unsubs) unsub()
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function extractFilePath(args: Record<string, unknown>): string | undefined {
  return (args.path ?? args.file_path ?? args.target ?? args.file) as string | undefined
}

function isTypeScriptPath(filePath: string): boolean {
  return /\.(tsx?|mts|cts)$/i.test(filePath)
}
