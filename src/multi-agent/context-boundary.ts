/**
 * ContextBoundary — Enforces isolation between parent and sub-agents.
 *
 * Controls:
 * - Which tools a sub-agent can call
 * - Which file paths it can access
 * - How much parent context it inherits
 * - Whether it can spawn its own children
 */

import type { ContextBoundary, IsolationLevel } from "./types.js"
import type { ToolRegistryLike } from "../agent/loop.js"
import { DEFAULT_BOUNDARY } from "./types.js"

export interface BoundaryConfig {
  isolationLevel?: IsolationLevel
  allowedTools?: string[]
  deniedTools?: string[]
  allowedPaths?: string[]
  maxDepth?: number
  maxConcurrent?: number
  canDelegate?: boolean
}

/**
 * Creates a ContextBoundary from partial config, merging with defaults.
 */
export function createBoundary(config: BoundaryConfig = {}): ContextBoundary {
  return {
    isolationLevel: config.isolationLevel ?? DEFAULT_BOUNDARY.isolationLevel,
    allowedTools: config.allowedTools ?? DEFAULT_BOUNDARY.allowedTools,
    deniedTools: config.deniedTools ?? DEFAULT_BOUNDARY.deniedTools,
    allowedPaths: config.allowedPaths ?? DEFAULT_BOUNDARY.allowedPaths,
    envPassthrough: DEFAULT_BOUNDARY.envPassthrough,
    maxDepth: config.maxDepth ?? DEFAULT_BOUNDARY.maxDepth,
    maxConcurrent: config.maxConcurrent ?? DEFAULT_BOUNDARY.maxConcurrent,
    canDelegate: config.canDelegate ?? DEFAULT_BOUNDARY.canDelegate,
  }
}

/**
 * Derives a child boundary from a parent boundary (depth decremented, more restrictive).
 */
export function deriveChildBoundary(
  parent: ContextBoundary,
  override: BoundaryConfig = {},
): ContextBoundary {
  const childDepth = parent.maxDepth - 1
  if (childDepth <= 0) {
    throw new Error("Maximum sub-agent depth exceeded")
  }

  // Child inherits parent's denied tools + can add more
  const mergedDenied = [
    ...new Set([...parent.deniedTools, ...(override.deniedTools ?? [])]),
  ]

  // Child's allowed tools must be subset of parent's (if parent has restrictions)
  let childAllowed = override.allowedTools ?? parent.allowedTools
  if (parent.allowedTools.length > 0 && childAllowed.length > 0) {
    const parentSet = new Set(parent.allowedTools)
    childAllowed = childAllowed.filter((t) => parentSet.has(t))
  }

  // Child's paths must be subset of parent's (if parent has restrictions)
  let childPaths = override.allowedPaths ?? parent.allowedPaths
  if (parent.allowedPaths.length > 0 && childPaths.length > 0) {
    childPaths = childPaths.filter((p) =>
      parent.allowedPaths.some((pp) => p.startsWith(pp)),
    )
  }

  return {
    isolationLevel: override.isolationLevel ?? parent.isolationLevel,
    allowedTools: childAllowed,
    deniedTools: mergedDenied,
    allowedPaths: childPaths,
    envPassthrough: parent.envPassthrough,
    maxDepth: childDepth,
    maxConcurrent: Math.min(
      override.maxConcurrent ?? parent.maxConcurrent,
      parent.maxConcurrent,
    ),
    canDelegate: parent.canDelegate && (override.canDelegate ?? true),
  }
}

/**
 * Creates a filtered ToolRegistry that respects boundary rules.
 * Acts as a proxy: only exposes tools that pass the boundary check.
 */
export function createScopedToolRegistry(
  base: ToolRegistryLike,
  boundary: ContextBoundary,
): ToolRegistryLike {
  const isAllowed = (name: string): boolean => {
    // Explicitly denied always wins
    if (boundary.deniedTools.includes(name)) return false
    // If allowedTools is empty, everything (except denied) is allowed
    if (boundary.allowedTools.length === 0) return true
    // Otherwise must be in the whitelist
    return boundary.allowedTools.includes(name)
  }

  return {
    get(name: string) {
      if (!isAllowed(name)) return null
      return base.get(name)
    },
    list() {
      return base.list().filter((t) => isAllowed(t.name))
    },
  }
}

/**
 * Validates whether a file path is accessible under the boundary.
 * Returns true if no path restrictions, or if path matches.
 */
export function isPathAllowed(
  filePath: string,
  boundary: ContextBoundary,
): boolean {
  if (boundary.allowedPaths.length === 0) return true
  return boundary.allowedPaths.some(
    (allowed) =>
      filePath === allowed || filePath.startsWith(allowed + "/"),
  )
}
