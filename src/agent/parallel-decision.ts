// src/agent/parallel-decision.ts
/**
 * Fine-grained parallel execution decision engine.
 *
 * Replaces the old blanket `SEQUENTIAL_TOOLS` set with a nuanced
 * rule engine inspired by Hermes's path-scoped + overlap detection.
 *
 * Philosophy: read-only operations should ALWAYS parallelize.
 * Write operations parallelize only when paths don't overlap.
 * Destructive shell commands are always sequential.
 */

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface ParallelDecision {
  canParallelize: boolean;
  reason?: string;
}

/** Tools that are always safe to parallelize (read-only, no side effects). */
const ALWAYS_PARALLEL = new Set([
  "read",
  "web_search",
  "web_fetch",
  "grep",
  "grep_tool",
  "repo_map",
  "list_agents",
  "list_sessions",
  "read_session",
  "memory_search",
  "memory_inspect",
  "view_image",
  "cloud_query",
  "dragon_api",
]);

/** Tools that must never run in parallel (require user interaction or global state). */
const NEVER_PARALLEL = new Set([
  "clarify_uncertainty",
  "create_agent",
  "switch_agent",
]);

/** Tools whose parallelism depends on path overlap. */
const PATH_SCOPED = new Set(["write", "edit"]);

/**
 * Patterns that indicate a shell command has side effects.
 * If an exec command matches any of these, it must run sequentially.
 */
const DESTRUCTIVE_PATTERNS: RegExp[] = [
  /\brm\s+(-[a-zA-Z]*\s+)*/, // rm with any flags
  /\bmv\s/,
  /\bcp\s/,
  /\bkill\b/,
  /\bpkill\b/,
  /\bsystemctl\s+(restart|stop|start|enable|disable)/,
  /\bservice\s+\w+\s+(restart|stop|start)/,
  /\bchmod\b/,
  /\bchown\b/,
  /\bmkdir\b/,
  /\btouch\b/,
  />(>)?/, // redirect to file
  /\bsed\s+-i/,
  /\btee\s/,
  /\bgit\s+(push|commit|merge|rebase|reset|checkout|branch\s+-[dD])/,
  /\bnpm\s+(install|uninstall|publish)/,
  /\bpnpm\s+(install|remove|publish)/,
  /\bpip\s+install/,
  /\bapt(-get)?\s+(install|remove|purge)/,
  /\bbrew\s+(install|uninstall|remove)/,
];

/**
 * Check if a shell command is read-only (no side effects).
 */
function isReadOnlyCommand(command: string): boolean {
  return !DESTRUCTIVE_PATTERNS.some((p) => p.test(command));
}

/**
 * Check if two path arrays have any overlap (one is prefix of another).
 */
function pathsOverlap(paths: string[]): boolean {
  if (paths.length <= 1) return false;
  const segments = paths.map((p) => p.split("/").filter(Boolean));
  segments.sort((a, b) => a.length - b.length);

  for (let i = 0; i < segments.length; i++) {
    for (let j = i + 1; j < segments.length; j++) {
      if (isPrefix(segments[i], segments[j])) return true;
    }
  }
  return false;
}

function isPrefix(shorter: string[], longer: string[]): boolean {
  return shorter.every((seg, idx) => longer[idx] === seg);
}

/**
 * Decide whether a batch of tool calls can be parallelized.
 */
export function decideParallelization(toolCalls: ToolCall[]): ParallelDecision {
  if (toolCalls.length <= 1) {
    return { canParallelize: false, reason: "single call" };
  }

  // Any NEVER_PARALLEL tool → entire batch is sequential
  if (toolCalls.some((tc) => NEVER_PARALLEL.has(tc.name))) {
    return { canParallelize: false, reason: "contains never-parallel tool" };
  }

  // All ALWAYS_PARALLEL → go parallel
  if (toolCalls.every((tc) => ALWAYS_PARALLEL.has(tc.name))) {
    return { canParallelize: true };
  }

  // Check exec commands
  const execCalls = toolCalls.filter(
    (tc) => tc.name === "exec" || tc.name === "execute_script",
  );
  for (const tc of execCalls) {
    const cmd = String(tc.args.command ?? tc.args.script ?? "");
    if (!isReadOnlyCommand(cmd)) {
      return {
        canParallelize: false,
        reason: `destructive exec: ${cmd.slice(0, 60)}`,
      };
    }
  }

  // Check PATH_SCOPED tools for path overlap
  const pathScopedCalls = toolCalls.filter((tc) => PATH_SCOPED.has(tc.name));
  if (pathScopedCalls.length > 1) {
    const paths = pathScopedCalls.map((tc) =>
      String(tc.args.path ?? tc.args.file ?? tc.args.target ?? ""),
    );
    if (pathsOverlap(paths)) {
      return {
        canParallelize: false,
        reason: "path-scoped tools with overlapping paths",
      };
    }
  }

  // Mixed batch: all execs are read-only, path-scoped don't overlap → parallel
  return { canParallelize: true };
}
