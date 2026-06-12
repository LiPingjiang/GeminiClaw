/**
 * SkillReflector — the "brain" of the Hermes-style skill evolution loop.
 *
 * Given a real conversation (problem analysis + transcript) and the set of
 * skills that already exist, the reflector asks the LLM to decide ONE of:
 *
 *   - create : this interaction contains a reusable lesson not yet captured →
 *              draft a NEW SKILL.md (crystallise).
 *   - refine : an existing skill is relevant but incomplete/wrong → produce an
 *              improved body for it (reflect + sharpen).
 *   - skip   : nothing reusable / too specific / already well covered.
 *
 * The decision + generated content is returned as a structured object; the
 * engine applies it via SkillStore. The LLM never writes files directly.
 *
 * This mirrors Hermes' "Reflect → Crystallise → Reuse" loop, with the
 * Bayesian flavour: refine makes existing skills sharper every time they're
 * exercised by a new conversation.
 */

import type { LlmClient, LlmMessage } from "./types.js"
import type { Skill } from "./skill-store.js"

// ── Types ────────────────────────────────────────────────────────────────────

export type ReflectionAction = "create" | "refine" | "skip"

export interface ReflectionInput {
  /** Short title of the conversation (for skill naming hints). */
  title: string
  /** Why this conversation was flagged (problem reasons). */
  problems: string[]
  /** Rendered transcript sample (already truncated by the caller). */
  transcript: string
  /** Existing skills the LLM may choose to refine instead of duplicating. */
  existingSkills: Pick<Skill, "meta">[]
}

export interface ReflectionResult {
  action: ReflectionAction
  /** For create: proposed skill name. For refine: the existing skill name. */
  skillName?: string
  /** One-line "when to use this" description (frontmatter). */
  description?: string
  /** Full Markdown body for the SKILL.md. */
  body?: string
  /** Optional tags. */
  tags?: string[]
  /** LLM's short rationale (logged, not persisted). */
  rationale: string
}

export interface SkillReflectorConfig {
  /** Max chars of transcript to feed the LLM. */
  maxTranscriptChars: number
}

export const DEFAULT_REFLECTOR_CONFIG: SkillReflectorConfig = {
  maxTranscriptChars: 6000,
}

// ── Reflector ────────────────────────────────────────────────────────────────

export class SkillReflector {
  constructor(
    private readonly llm: LlmClient,
    private readonly config: SkillReflectorConfig = DEFAULT_REFLECTOR_CONFIG,
  ) {}

  async reflect(input: ReflectionInput): Promise<ReflectionResult> {
    const messages = this.buildPrompt(input)
    const raw = await this.llm.chat(messages)
    return this.parse(raw)
  }

  // ── Prompt construction ────────────────────────────────────────────────────

  private buildPrompt(input: ReflectionInput): LlmMessage[] {
    const transcript =
      input.transcript.length > this.config.maxTranscriptChars
        ? input.transcript.slice(0, this.config.maxTranscriptChars) + "\n…(truncated)…"
        : input.transcript

    const existingList =
      input.existingSkills.length > 0
        ? input.existingSkills
            .map(
              (s) =>
                `- ${s.meta.name}: ${s.meta.description} (v${s.meta.version}, used ${s.meta.usage_count}x)`,
            )
            .join("\n")
        : "(none yet)"

    const system = [
      "You are the skill-evolution reflector for an autonomous AI agent.",
      "Your job: look at ONE real past conversation and decide whether it",
      "contains a REUSABLE lesson worth saving as a 'skill' — a concise,",
      "actionable Markdown playbook the agent can load next time it faces a",
      "similar task.",
      "",
      "DEFAULT TO 'skip'. Crystallising a bad or over-specific skill is WORSE",
      "than crystallising nothing: it pollutes the library and misleads future",
      "runs. Only create/refine when the lesson is genuinely reusable AND",
      "clears every guardrail below.",
      "",
      "You must choose exactly one action:",
      "  - create : a genuinely new, reusable lesson not covered by existing skills.",
      "  - refine : an existing skill is relevant but should be improved/corrected",
      "             using what this conversation revealed.",
      "  - skip   : nothing reusable, too situation-specific, or already covered.",
      "",
      "A GOOD skill is generalizable (not about this one user/session), concrete",
      "(steps, gotchas, commands, checklists), and has clear trigger conditions.",
      "Prefer 'refine' over creating near-duplicates. Prefer 'skip' over saving",
      "low-value or one-off trivia.",
      "",
      "DO NOT CRYSTALLISE (these MUST be 'skip') — reverse guardrails:",
      "  - Environment-specific or transient failures (a flaky network call, a",
      "    missing local file, a one-off permission error) — they will not",
      "    reproduce and are not a general lesson.",
      "  - Errors that self-healed on retry without any real technique change —",
      "    'I tried again and it worked' is not a skill.",
      "  - Negative tool assertions ('tool X does not support Y', 'this API is",
      "    broken') — these go stale fast and may simply be wrong; do not encode",
      "    them as durable knowledge.",
      "  - Anything that depends on THIS specific user, session, repo path,",
      "    secret, ticket number, or one-time data — strip or skip; never bake",
      "    session-specific identifiers into a skill.",
      "  - Single-use trivia, restating the obvious, or summarising what any",
      "    competent agent already knows.",
      "  - A conversation that never actually succeeded at anything reusable —",
      "    if there is no working approach to teach, skip.",
      "",
      "DO CRYSTALLISE when you see genuine signal:",
      "  - The user corrected the agent's style, workflow, or approach in a way",
      "    that should persist next time.",
      "  - A non-trivial technique, sequence, command set, or gotcha emerged that",
      "    a fresh agent would plausibly get wrong.",
      "  - An existing loaded skill turned out to be wrong/incomplete and this",
      "    conversation reveals the correct patch (prefer 'refine').",
      "",
      "Respond with ONLY a JSON object, no prose, no markdown fences:",
      "{",
      '  "action": "create" | "refine" | "skip",',
      '  "skillName": "kebab-case-name (for create) OR exact existing name (for refine)",',
      '  "description": "one sentence: when should the agent use this skill",',
      '  "body": "full Markdown playbook (## headings, steps, gotchas)",',
      '  "tags": ["optional", "keywords"],',
      '  "rationale": "1-2 sentences explaining your choice"',
      "}",
      "",
      "CRITICAL JSON RULES (your output is parsed by a machine):",
      '  - Output a SINGLE valid JSON object and nothing else.',
      '  - The "body" value is a JSON string: escape every newline as \\n and',
      '    every double-quote as \\". Do NOT put raw line breaks inside strings.',
      "  - No trailing commas. No comments. No markdown fences.",
      "For action=skip, only 'action' and 'rationale' are required.",
    ].join("\n")

    const problemsBlock =
      input.problems.length > 0
        ? ["## Pre-flagged signals (hints only — make your own judgement)", ...input.problems.map((p) => `- ${p}`), ""]
        : []

    const user = [
      `# Conversation under review: "${input.title}"`,
      "",
      "Read the WHOLE conversation below (long middles may be summarised).",
      "First decide if it clears the guardrails for crystallisation; if not,",
      "return action=skip. Only then draft a skill.",
      "",
      ...problemsBlock,
      "## Existing skills (candidates for refine)",
      existingList,
      "",
      "## Transcript",
      transcript,
    ].join("\n")

    return [
      { role: "system", content: system },
      { role: "user", content: user },
    ]
  }

  // ── Response parsing ───────────────────────────────────────────────────────

  private parse(raw: string): ReflectionResult {
    const json = this.extractJson(raw) ?? this.salvageFields(raw)
    if (!json) {
      const preview = raw.replace(/\s+/g, " ").trim().slice(0, 200)
      return {
        action: "skip",
        rationale: `Reflector returned unparseable output; skipping. raw="${preview}"`,
      }
    }

    const action = (json.action as string)?.toLowerCase()
    if (action === "create" || action === "refine") {
      const body = typeof json.body === "string" ? json.body.trim() : ""
      const skillName = typeof json.skillName === "string" ? json.skillName.trim() : ""
      const description =
        typeof json.description === "string" ? json.description.trim() : ""
      // Guard: create/refine must carry usable content.
      if (!skillName || !body || !description) {
        return {
          action: "skip",
          rationale: `Reflector chose ${action} but omitted required fields; skipping.`,
        }
      }
      return {
        action,
        skillName,
        description,
        body,
        tags: Array.isArray(json.tags)
          ? json.tags.filter((t: unknown): t is string => typeof t === "string")
          : undefined,
        rationale: typeof json.rationale === "string" ? json.rationale : "",
      }
    }

    return {
      action: "skip",
      rationale: typeof json.rationale === "string" ? json.rationale : "No reusable lesson.",
    }
  }

  /** Tolerantly extract a JSON object from an LLM response. */
  private extractJson(raw: string): Record<string, unknown> | null {
    if (!raw) return null
    // Strip code fences if present.
    let text = raw.trim()
    const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/)
    if (fenceMatch) {
      text = fenceMatch[1].trim()
    }
    // Find the outermost JSON object.
    const start = text.indexOf("{")
    const end = text.lastIndexOf("}")
    if (start === -1 || end === -1 || end <= start) return null
    const candidate = text.slice(start, end + 1)

    // Attempt 1: strict parse.
    try {
      return JSON.parse(candidate) as Record<string, unknown>
    } catch {
      /* fall through */
    }
    // Attempt 2: trailing-comma cleanup (a very common LLM mistake).
    try {
      const cleaned = candidate.replace(/,(\s*[}\]])/g, "$1")
      return JSON.parse(cleaned) as Record<string, unknown>
    } catch {
      return null
    }
  }

  /**
   * Last-resort salvage when the LLM emits JSON-ish output whose long Markdown
   * `body` string contains raw (unescaped) newlines/quotes that break
   * JSON.parse. We extract each field with tolerant regexes rather than losing
   * the whole crystallised skill.
   */
  private salvageFields(raw: string): Record<string, unknown> | null {
    if (!raw) return null
    let text = raw.trim()
    const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/)
    if (fenceMatch) text = fenceMatch[1].trim()

    const action = this.matchScalar(text, "action")
    if (!action) return null

    const result: Record<string, unknown> = { action }

    const skillName = this.matchScalar(text, "skillName")
    if (skillName) result.skillName = skillName
    const description = this.matchScalar(text, "description")
    if (description) result.description = description
    const rationale = this.matchScalar(text, "rationale")
    if (rationale) result.rationale = rationale

    // body: grab everything between the opening quote after "body": and the
    // last quote that precedes the next top-level key or the closing brace.
    const body = this.matchBody(text)
    if (body) result.body = body

    // tags: a simple ["a","b"] array.
    const tagsMatch = text.match(/"tags"\s*:\s*\[([^\]]*)\]/)
    if (tagsMatch) {
      const tags = tagsMatch[1]
        .split(",")
        .map((t) => t.trim().replace(/^["']|["']$/g, ""))
        .filter((t) => t.length > 0)
      if (tags.length > 0) result.tags = tags
    }

    return result
  }

  /** Match a short single-line-ish scalar string field. */
  private matchScalar(text: string, key: string): string | undefined {
    const re = new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`)
    const m = text.match(re)
    if (!m) return undefined
    return this.unescape(m[1])
  }

  /** Match the (possibly multi-line, unescaped) body field tolerantly. */
  private matchBody(text: string): string | undefined {
    const keyIdx = text.search(/"body"\s*:\s*"/)
    if (keyIdx === -1) return undefined
    const open = text.indexOf('"', text.indexOf(":", keyIdx)) + 1
    // Find the end: the next occurrence of a quote that is immediately
    // followed (ignoring whitespace) by a comma+key or the closing brace.
    const tail = text.slice(open)
    const endMatch = tail.match(/"\s*(?:,\s*"(?:skillName|description|tags|rationale)"|\}\s*$|\})/)
    let body: string
    if (endMatch && endMatch.index !== undefined) {
      body = tail.slice(0, endMatch.index)
    } else {
      // Fall back to the last quote in the tail.
      const lastQuote = tail.lastIndexOf('"')
      body = lastQuote > 0 ? tail.slice(0, lastQuote) : tail
    }
    const cleaned = this.unescape(body).trim()
    return cleaned.length > 0 ? cleaned : undefined
  }

  private unescape(s: string): string {
    return s
      .replace(/\\n/g, "\n")
      .replace(/\\t/g, "\t")
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, "\\")
  }
}
