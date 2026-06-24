/**
 * System prompt builder.
 *
 * Assembles the final system prompt from three sources:
 *   1. identity   — AGENT.md (user-managed, identity + domain knowledge only)
 *   2. universal  — code constants injected for all models
 *   3. model-spec — code constants injected conditionally by model family
 *
 * This module owns the "how to build the prompt" logic.
 * AGENT.md owns the "who am I and what do I know" content.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "fs"
import { join } from "path"
import os from "os"

import {
  TOOL_USE_ENFORCEMENT,
  PREREQUISITE_CHECKS,
  GROUNDING_VERIFICATION,
  CLAUDE_MANDATORY_TOOL_USE,
  CLAUDE_ACT_DONT_ASK,
  STRICT_MANDATORY_TOOL_USE,
} from "./constants.js"
import { detectModelFamily, type ModelFamily } from "./families.js"

// ── Identity: load AGENT.md ───────────────────────────────────────────────

function loadIdentity(): string {
  const path = join(os.homedir(), ".gemeniclaw", "AGENT.md")
  if (existsSync(path)) {
    return readFileSync(path, "utf-8").trim()
  }
  return "你是 GeminiClaw，一个智能 AI 助手。回答简洁、准确、有帮助。"
}

// ── Skills: existing logic, unchanged ────────────────────────────────────

function loadSkillsPrompt(skillsDir: string): string {
  if (!existsSync(skillsDir)) return ""
  let entries: string[]
  try {
    entries = readdirSync(skillsDir)
  } catch {
    return ""
  }
  const parts: string[] = []
  for (const entry of entries) {
    if (entry.startsWith(".")) continue
    const entryPath = join(skillsDir, entry)
    try {
      if (!statSync(entryPath).isDirectory()) continue
    } catch {
      continue
    }
    const skillFile = join(entryPath, "SKILL.md")
    if (!existsSync(skillFile)) continue
    try {
      const content = readFileSync(skillFile, "utf-8").trim()
      let body = content
      if (content.startsWith("---")) {
        const end = content.indexOf("---", 3)
        if (end !== -1) body = content.slice(end + 3).trim()
      }
      if (body) parts.push(body)
    } catch { /* skip */ }
  }
  if (parts.length === 0) return ""
  return "\n\n---\n\n## 可用技能\n\n" + parts.join("\n\n---\n\n")
}

// ── Model-specific guidance blocks ───────────────────────────────────────

function getModelGuidance(family: ModelFamily): string {
  switch (family) {
    case "claude":
      // Lightweight: mandatory tool use targeting Claude's specific failure mode
      // (answering from in-context memory instead of re-fetching)
      // + act-don't-ask for clarity
      return [CLAUDE_MANDATORY_TOOL_USE, CLAUDE_ACT_DONT_ASK].join("\n\n")

    case "gemini":
    case "gpt":
    case "unknown":
      // Strict: full NEVER-from-memory guidance for models more prone to hallucination
      return STRICT_MANDATORY_TOOL_USE
  }
}

// ── Main export ───────────────────────────────────────────────────────────

/**
 * Build the full system prompt.
 *
 * @param routingDefault  e.g. "mcli/claude-opus-4-6" from config.routing.default
 *                        If omitted, universal-only guidance is used.
 */
export function buildSystemPrompt(routingDefault?: string): string {
  const family = routingDefault ? detectModelFamily(routingDefault) : "unknown"

  const parts: string[] = [
    // 1. Identity (user-managed)
    loadIdentity(),

    // 2. Universal guidance (all models)
    TOOL_USE_ENFORCEMENT,
    PREREQUISITE_CHECKS,
    GROUNDING_VERIFICATION,

    // 3. Model-family-specific guidance
    getModelGuidance(family),

    // 4. Skills (existing, cwd-scoped)
    loadSkillsPrompt(join(process.cwd(), "skills")),
  ]

  return parts.filter(Boolean).join("\n\n")
}
