/**
 * Multi-Agent Runtime Context — module-level singleton.
 *
 * The `delegate_tasks` tool needs access to the same `chatFn` and tool
 * registry that the main AgentLoop uses, but tool handlers only receive a
 * `ToolContext`. Rather than thread these dependencies through every channel
 * call signature, the server wires them here once at startup, and the tool
 * reads them back at invocation time.
 *
 * This keeps the tool fully decoupled from the server/channel plumbing.
 */

import type { ChatFn, ToolRegistryLike } from "../agent/loop.js"

export interface MultiAgentRuntime {
  chatFn: ChatFn
  toolRegistry: ToolRegistryLike
}

let _runtime: MultiAgentRuntime | null = null

/** Called once by the server after building chatFn + registry adapter. */
export function setMultiAgentRuntime(rt: MultiAgentRuntime): void {
  _runtime = rt
}

/** Returns the wired runtime, or null if delegation is not available. */
export function getMultiAgentRuntime(): MultiAgentRuntime | null {
  return _runtime
}

/** Test helper: clear the singleton. */
export function __resetMultiAgentRuntime(): void {
  _runtime = null
}
