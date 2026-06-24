/**
 * Model family detection.
 *
 * Input: routing.default value, e.g. "mcli/claude-opus-4-6"
 * Output: model family used for conditional prompt injection.
 *
 * Claude family → lightweight mandatory-tool-use (Option C)
 * Gemini/GPT/other → strict mandatory-tool-use (NEVER from memory)
 * Unknown → universal only (no model-specific block)
 */

export type ModelFamily = "claude" | "gemini" | "gpt" | "unknown"

/** Token patterns that identify each model family (case-insensitive substring match). */
const FAMILY_PATTERNS: Record<Exclude<ModelFamily, "unknown">, readonly string[]> = {
  claude: ["claude", "opus", "sonnet", "haiku"],
  gemini: ["gemini", "gemma"],
  gpt: ["gpt", "codex", "grok", "glm", "qwen", "deepseek", "o1", "o3", "o4"],
}

/**
 * Detect model family from a routing string like "mcli/claude-opus-4-6".
 * Takes the portion after the last "/" for matching.
 */
export function detectModelFamily(routingDefault: string): ModelFamily {
  // "mcli/claude-opus-4-6" → "claude-opus-4-6"
  const modelSlug = (routingDefault.split("/").pop() ?? routingDefault).toLowerCase()

  for (const [family, patterns] of Object.entries(FAMILY_PATTERNS) as Array<
    [Exclude<ModelFamily, "unknown">, readonly string[]]
  >) {
    if (patterns.some(p => modelSlug.includes(p))) {
      return family
    }
  }
  return "unknown"
}
