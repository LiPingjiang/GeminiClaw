/**
 * System prompt builder.
 *
 * Assembles the final system prompt from three sources:
 *   1. identity   — AGENT.md (user-managed, identity + domain knowledge only)
 *   2. universal  — code constants injected for all models
 *   3. model-spec — code constants injected conditionally by model family
 *
 * Per-agent config (AgentConfig) allows overriding skills, constants, and model
 * at the agent level. Falls back to global defaults when not specified.
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

// ── Per-agent config type ─────────────────────────────────────────────────

export interface AgentConfig {
  /** Whitelist of skill names to load. null/undefined = all global skills. [] = none. */
  skills?: string[] | null
  /** Override specific code constants. null value = disable that constant. */
  constants?: Partial<Record<ConstantKey, string | null>>
  /** Override routing model for this agent. null/undefined = use global routing.default. */
  model?: string | null
}

export type ConstantKey =
  | "TOOL_USE_ENFORCEMENT"
  | "PREREQUISITE_CHECKS"
  | "GROUNDING_VERIFICATION"
  | "CLAUDE_MANDATORY_TOOL_USE"
  | "CLAUDE_ACT_DONT_ASK"
  | "STRICT_MANDATORY_TOOL_USE"

// ── Identity: load AGENT.md ───────────────────────────────────────────────

function loadIdentity(): string {
  const path = join(os.homedir(), ".gemeniclaw", "AGENT.md")
  if (existsSync(path)) {
    return readFileSync(path, "utf-8").trim()
  }
  return "你是 GeminiClaw，一个智能 AI 助手。回答简洁、准确、有帮助。"
}

// ── Skills: per-agent whitelist or global ────────────────────────────────

function loadSkillsPrompt(skillsDir: string, allowedSkills?: string[] | null): string {
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
    // Per-agent whitelist filter (null/undefined = allow all)
    if (allowedSkills !== null && allowedSkills !== undefined && !allowedSkills.includes(entry)) continue
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

// ── Constants: per-agent override with fallback ───────────────────────────

/** Resolve a constant: agent override > global. null = disabled. */
function resolveConstant(
  key: ConstantKey,
  globalValue: string,
  agentConstants?: AgentConfig["constants"],
): string {
  if (!agentConstants || !(key in agentConstants)) return globalValue
  const override = agentConstants[key]
  return override ?? "" // null/empty = disabled
}

// ── Model-specific guidance ───────────────────────────────────────────────

function getModelGuidance(
  family: ModelFamily,
  agentConstants?: AgentConfig["constants"],
): string {
  if (family === "claude") {
    const mandatory = resolveConstant("CLAUDE_MANDATORY_TOOL_USE", CLAUDE_MANDATORY_TOOL_USE, agentConstants)
    const actDontAsk = resolveConstant("CLAUDE_ACT_DONT_ASK", CLAUDE_ACT_DONT_ASK, agentConstants)
    return [mandatory, actDontAsk].filter(Boolean).join("\n\n")
  }
  return resolveConstant("STRICT_MANDATORY_TOOL_USE", STRICT_MANDATORY_TOOL_USE, agentConstants)
}

// ── Main export ───────────────────────────────────────────────────────────

/**
 * Build the full system prompt, optionally with per-agent overrides.
 *
 * @param routingDefault  e.g. "mcli/claude-opus-4-6" from config.routing.default
 * @param agentConfig     per-agent overrides for skills, constants, model
 */
export function buildSystemPrompt(routingDefault?: string, agentConfig?: AgentConfig): string {
  // Effective model: agent override > global routing
  const effectiveModel = agentConfig?.model ?? routingDefault
  const family = effectiveModel ? detectModelFamily(effectiveModel) : "unknown"
  const agentConstants = agentConfig?.constants

  const parts: string[] = [
    // 1. Identity (user-managed)
    loadIdentity(),

    // 2. Universal guidance (all models) — per-agent overrideable
    resolveConstant("TOOL_USE_ENFORCEMENT", TOOL_USE_ENFORCEMENT, agentConstants),
    resolveConstant("PREREQUISITE_CHECKS", PREREQUISITE_CHECKS, agentConstants),
    resolveConstant("GROUNDING_VERIFICATION", GROUNDING_VERIFICATION, agentConstants),

    // 3. Model-family-specific guidance — per-agent overrideable
    getModelGuidance(family, agentConstants),

    // 4. Skills — per-agent whitelist (null/undefined = all, [] = none)
    loadSkillsPrompt(join(process.cwd(), "skills"), agentConfig?.skills),
  ]

  return parts.filter(Boolean).join("\n\n")
}
