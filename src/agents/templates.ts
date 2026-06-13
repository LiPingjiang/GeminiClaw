// src/agents/templates.ts
/**
 * Named Agent Templates — config-driven agent definitions.
 *
 * Each template defines a named agent with its own system prompt, tool set,
 * model preference, and capabilities description. Used by `delegate_to` tool
 * for cross-agent delegation.
 */

export interface AgentTemplate {
  /** Unique name for routing (e.g. "translator", "researcher") */
  name: string
  /** Display name shown to users */
  displayName: string
  /** System prompt for this agent type */
  systemPrompt: string
  /** Tool whitelist (empty = all tools) */
  tools: string[]
  /** Tool denylist */
  deniedTools: string[]
  /** Preferred model override */
  model?: string
  /** Max turns per task */
  maxTurns: number
  /** Description for other agents to understand capabilities */
  capabilities: string
}

let _templates: AgentTemplate[] = []

/**
 * Load agent templates from config. Called once at startup.
 */
export function loadAgentTemplates(config: { agents?: AgentTemplate[] }): AgentTemplate[] {
  _templates = (config.agents ?? []).map((t) => ({
    name: t.name,
    displayName: t.displayName ?? t.name,
    systemPrompt: t.systemPrompt ?? "",
    tools: t.tools ?? [],
    deniedTools: t.deniedTools ?? [],
    model: t.model,
    maxTurns: t.maxTurns ?? 12,
    capabilities: t.capabilities ?? "",
  }))
  return _templates
}

/**
 * Find a template by its unique name.
 */
export function getTemplateByName(name: string): AgentTemplate | null {
  return _templates.find((t) => t.name === name) ?? null
}

/**
 * List all available template names (for tool descriptions / routing).
 */
export function listTemplateNames(): string[] {
  return _templates.map((t) => t.name)
}

/**
 * Get all templates (for display).
 */
export function getAllTemplates(): AgentTemplate[] {
  return [..._templates]
}

/** Test helper */
export function __resetTemplates(): void {
  _templates = []
}
