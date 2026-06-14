/**
 * Result Parser — Extracts structured three-part results from sub-agent output.
 *
 * Expected format from sub-agent:
 *   **结论**: ...
 *   **详情**: ...
 *   **附加上下文**: ... (optional)
 *
 * Also supports English format:
 *   **Conclusion**: ...
 *   **Details**: ...
 *   **Additional Context**: ... (optional)
 *
 * If the output doesn't match the expected format, returns the raw output
 * as the "details" field with a generic conclusion.
 */

import type { StructuredResult } from "./types.js"

/**
 * Parse sub-agent output into a structured three-part result.
 * Gracefully handles non-conforming output by treating it as raw details.
 */
export function parseStructuredResult(rawOutput: string): StructuredResult {
  if (!rawOutput || !rawOutput.trim()) {
    return {
      conclusion: "任务完成（无输出）",
      details: "",
    }
  }

  const text = rawOutput.trim()

  // Try Chinese format first
  let conclusion = extractSection(text, /\*\*结论\*\*[:：]\s*/i)
  let details = extractSection(text, /\*\*详情\*\*[:：]\s*/i)
  let additionalContext = extractSection(text, /\*\*附加上下文\*\*[:：]\s*/i)

  // Try English format if Chinese didn't match
  if (!conclusion && !details) {
    conclusion = extractSection(text, /\*\*Conclusion\*\*[:：]\s*/i)
    details = extractSection(text, /\*\*Details\*\*[:：]\s*/i)
    additionalContext = extractSection(text, /\*\*Additional Context\*\*[:：]\s*/i)
  }

  // If still no structured format detected, use raw output
  if (!conclusion && !details) {
    // Try to extract a conclusion from the first line/paragraph
    const firstLine = text.split("\n")[0].trim()
    const isShort = firstLine.length < 200
    return {
      conclusion: isShort ? firstLine : "任务已完成",
      details: text,
    }
  }

  return {
    conclusion: conclusion || "任务已完成",
    details: details || text,
    additionalContext: additionalContext || undefined,
  }
}

/**
 * Extract a section from text that starts with the given pattern.
 * The section ends at the next ** header or end of text.
 */
function extractSection(text: string, headerPattern: RegExp): string | null {
  const match = text.match(headerPattern)
  if (!match || match.index === undefined) return null

  const startIdx = match.index + match[0].length
  const remaining = text.slice(startIdx)

  // Find the next section header (** at start of line)
  const nextHeader = remaining.match(/\n\*\*[^*]+\*\*[:：]/)
  const endIdx = nextHeader?.index ?? remaining.length

  return remaining.slice(0, endIdx).trim()
}

/**
 * Format a structured result for display to the user.
 * Used by ResultInjector when pushing results.
 */
export function formatStructuredResult(result: StructuredResult, title: string): string {
  const parts: string[] = []
  parts.push(`📌 ${title}`)
  parts.push(`结论: ${result.conclusion}`)
  if (result.details) {
    // Truncate very long details for push notifications
    const details = result.details.length > 1500
      ? result.details.slice(0, 1500) + "…"
      : result.details
    parts.push(`\n${details}`)
  }
  if (result.additionalContext) {
    parts.push(`\n💡 附加上下文: ${result.additionalContext}`)
  }
  return parts.join("\n")
}
