/**
 * src/security/path-validator.ts
 * Path traversal prevention — ensures file operations stay within allowed directories.
 */

import { resolve, relative, isAbsolute } from "path"

export class PathValidator {
  private allowedRoots: string[]

  constructor(allowedRoots: string[]) {
    this.allowedRoots = allowedRoots.map((r) => resolve(r))
  }

  /**
   * Check if a given path is safely within one of the allowed roots.
   * Returns { safe: true, resolved } or { safe: false, reason }.
   */
  validate(targetPath: string): { safe: true; resolved: string } | { safe: false; reason: string } {
    // Normalize the target
    const resolved = isAbsolute(targetPath)
      ? resolve(targetPath)
      : resolve(process.cwd(), targetPath)

    // Check for ".." traversal in raw input (catches encoded traversal attempts)
    if (targetPath.includes("..")) {
      // After resolving, verify it's still within an allowed root
      const isContained = this.allowedRoots.some((root) => {
        const rel = relative(root, resolved)
        return !rel.startsWith("..") && !isAbsolute(rel)
      })
      if (!isContained) {
        return {
          safe: false,
          reason: `Path "${targetPath}" escapes allowed directories via traversal`,
        }
      }
    }

    // Final containment check
    for (const root of this.allowedRoots) {
      const rel = relative(root, resolved)
      if (!rel.startsWith("..") && !isAbsolute(rel)) {
        return { safe: true, resolved }
      }
    }

    return {
      safe: false,
      reason: `Path "${resolved}" is outside allowed directories: [${this.allowedRoots.join(", ")}]`,
    }
  }

  /**
   * Add an additional allowed root (e.g., when user opens a new workspace).
   */
  addRoot(root: string): void {
    const resolved = resolve(root)
    if (!this.allowedRoots.includes(resolved)) {
      this.allowedRoots.push(resolved)
    }
  }
}
