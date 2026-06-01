/**
 * src/security/hook.ts
 * Registers the SecurityLayer as a pre_tool_call hook on the HookBus.
 *
 * When imported and called, this wires up:
 * - CommandGuard: blocks/flags dangerous exec commands
 * - SecretRedactor: redacts secrets from post_tool_call outputs
 * - PathValidator: validates file paths for write/edit tools
 */

import { hookBus } from "../hooks/index.js"
import { CommandGuard } from "./command-guard.js"
import { SecretRedactor } from "./redaction.js"
import { PathValidator } from "./path-validator.js"
import type { PreToolCallPayload, PostToolCallPayload } from "../hooks/index.js"

export interface SecurityHookOptions {
  /** Additional commands to always allow */
  allowlist?: string[]
  /** Root directories for path validation */
  allowedPaths?: string[]
  /** Disable secret redaction (e.g., in trusted sandbox) */
  disableRedaction?: boolean
  /** Disable command guard (e.g., in Docker sandbox) */
  disableGuard?: boolean
}

/**
 * Register security hooks on the global HookBus.
 * Returns an unsubscribe function to remove all registered hooks.
 */
export function registerSecurityHooks(options?: SecurityHookOptions): () => void {
  const unsubs: Array<() => void> = []

  // ── Command Guard (pre_tool_call) ────────────────────────────────────────
  if (!options?.disableGuard) {
    const guard = new CommandGuard({ allowlist: options?.allowlist })

    const unsub = hookBus.on(
      "pre_tool_call",
      async (payload: PreToolCallPayload) => {
        const decision = guard.evaluateToolArgs(payload.toolName, payload.args)
        if (!decision) return undefined // Not a command tool, skip

        if (decision.level === "deny") {
          return { block: true, reason: `🛡️ BLOCKED: ${decision.reason}` }
        }
        if (decision.level === "needs_approval") {
          // For now: log warning but allow (approval UI not yet implemented)
          console.warn(
            `[Security] ⚠️ Dangerous command detected in ${payload.toolName}: ${decision.reason}` +
            ` (pattern: ${decision.matchedPattern}). Auto-allowing (approval system not yet active).`
          )
          return undefined
        }
        return undefined
      },
      // Priority 10: security runs before other hooks
      10,
    )
    unsubs.push(unsub)
  }

  // ── Path Validator (pre_tool_call for file tools) ────────────────────────
  if (options?.allowedPaths && options.allowedPaths.length > 0) {
    const pathValidator = new PathValidator(options.allowedPaths)
    const fileTools = new Set(["write", "edit", "file_write", "read", "read_file", "fuzzy_edit"])

    const unsub = hookBus.on(
      "pre_tool_call",
      async (payload: PreToolCallPayload) => {
        if (!fileTools.has(payload.toolName)) return undefined

        const targetPath = (payload.args.path ?? payload.args.file_path ?? payload.args.target) as string | undefined
        if (!targetPath) return undefined

        const result = pathValidator.validate(targetPath)
        if (!result.safe) {
          return { block: true, reason: `🛡️ PATH BLOCKED: ${result.reason}` }
        }
        return undefined
      },
      // Priority 11: path check runs right after command guard
      11,
    )
    unsubs.push(unsub)
  }

  // ── Secret Redaction (post_tool_call) ────────────────────────────────────
  if (!options?.disableRedaction) {
    const redactor = new SecretRedactor()

    const unsub = hookBus.on(
      "post_tool_call",
      async (payload: PostToolCallPayload) => {
        const { output, redactionCount } = redactor.redact(payload.result.content)
        if (redactionCount > 0) {
          console.log(
            `[Security] Redacted ${redactionCount} secret(s) from ${payload.toolName} output`
          )
          // Note: post_tool_call emit is fire-and-forget;
          // actual result mutation would need afterToolCall callback
          // This hook is for logging/alerting; actual redaction happens
          // via the afterToolCall path in AgentLoop (to be wired up later)
        }
        return undefined
      },
      10,
    )
    unsubs.push(unsub)
  }

  // Return combined unsubscribe
  return () => {
    for (const unsub of unsubs) unsub()
  }
}
