/**
 * SkillStore — persistence layer for Hermes-style skill files.
 *
 * A "skill" is a directory under the skills root (default ~/.geminiclaw/skills/)
 * containing a single SKILL.md file:
 *
 *   ~/.geminiclaw/skills/
 *     ├── debugging-ssh-remote/
 *     │   └── SKILL.md
 *     └── pdf-extraction/
 *         └── SKILL.md
 *
 * SKILL.md has YAML frontmatter + a Markdown body, mirroring the Hermes /
 * Anthropic agent-skill format:
 *
 *   ---
 *   name: debugging-ssh-remote
 *   description: When to use this skill (trigger conditions)...
 *   version: 3
 *   created_at: 2026-06-12T01:00:00.000Z
 *   updated_at: 2026-06-12T02:00:00.000Z
 *   usage_count: 0
 *   source: conversation-reflection
 *   ---
 *
 *   # Debugging SSH Remote
 *   ...the actual reusable knowledge...
 *
 * The store is filesystem-only (no compilation, no git). This is what makes the
 * skill engine low-risk compared with the code engine.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  statSync,
} from "fs"
import { join } from "path"
import { homedir } from "os"

// ── Types ────────────────────────────────────────────────────────────────────

export interface SkillMeta {
  name: string
  description: string
  version: number
  created_at: string
  updated_at: string
  usage_count: number
  /** Where the skill came from: "conversation-reflection" | "manual" | ... */
  source: string
  /** Optional free-form tags for matching. */
  tags?: string[]
}

export interface Skill {
  meta: SkillMeta
  /** Markdown body (everything after the frontmatter). */
  body: string
  /** Absolute path to the SKILL.md file. */
  path: string
}

export interface SkillStoreOptions {
  /** Root directory for skills. Defaults to ~/.geminiclaw/skills. */
  root?: string
}

// ── Frontmatter parse / serialize (minimal, dependency-free) ─────────────────

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/

function parseFrontmatter(raw: string): { meta: Partial<SkillMeta>; body: string } {
  const m = raw.match(FRONTMATTER_RE)
  if (!m) {
    return { meta: {}, body: raw.trim() }
  }
  const yaml = m[1]
  const body = m[2].trim()
  const meta: Record<string, unknown> = {}

  for (const line of yaml.split("\n")) {
    const idx = line.indexOf(":")
    if (idx === -1) continue
    const key = line.slice(0, idx).trim()
    let value: string = line.slice(idx + 1).trim()
    if (!key) continue

    // Strip surrounding quotes.
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }

    if (key === "tags") {
      // Support inline array form: [a, b, c]
      const inner = value.replace(/^\[/, "").replace(/\]$/, "")
      meta.tags = inner
        .split(",")
        .map((t) => t.trim().replace(/^["']|["']$/g, ""))
        .filter(Boolean)
    } else if (key === "version" || key === "usage_count") {
      meta[key] = Number(value) || 0
    } else {
      meta[key] = value
    }
  }

  return { meta: meta as Partial<SkillMeta>, body }
}

function serializeFrontmatter(meta: SkillMeta, body: string): string {
  const escape = (s: string): string => s.replace(/\n/g, " ").replace(/"/g, '\\"')
  const lines = [
    "---",
    `name: ${meta.name}`,
    `description: "${escape(meta.description)}"`,
    `version: ${meta.version}`,
    `created_at: ${meta.created_at}`,
    `updated_at: ${meta.updated_at}`,
    `usage_count: ${meta.usage_count}`,
    `source: ${meta.source}`,
  ]
  if (meta.tags && meta.tags.length > 0) {
    lines.push(`tags: [${meta.tags.map((t) => t).join(", ")}]`)
  }
  lines.push("---", "", body.trim(), "")
  return lines.join("\n")
}

// ── Name normalization ───────────────────────────────────────────────────────

/** Turn an arbitrary title into a safe kebab-case directory name. */
export function slugifySkillName(name: string): string {
  const slug = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
  return slug || `skill-${Date.now()}`
}

// ── Store ────────────────────────────────────────────────────────────────────

export class SkillStore {
  readonly root: string

  constructor(options: SkillStoreOptions = {}) {
    this.root = options.root ?? join(homedir(), ".geminiclaw", "skills")
  }

  /** Ensure the skills root exists. */
  ensureRoot(): void {
    mkdirSync(this.root, { recursive: true })
  }

  /** List all skill names (directory names that contain a SKILL.md). */
  listNames(): string[] {
    if (!existsSync(this.root)) return []
    return readdirSync(this.root).filter((entry) => {
      const dir = join(this.root, entry)
      try {
        return statSync(dir).isDirectory() && existsSync(join(dir, "SKILL.md"))
      } catch {
        return false
      }
    })
  }

  /** Load all skills. */
  listAll(): Skill[] {
    return this.listNames()
      .map((name) => this.get(name))
      .filter((s): s is Skill => s !== null)
  }

  /** Whether a skill with this name exists (name is slugified for lookup). */
  has(name: string): boolean {
    return existsSync(join(this.root, slugifySkillName(name), "SKILL.md"))
  }

  /** Load a single skill by name (slugified for lookup). Returns null if missing. */
  get(name: string): Skill | null {
    const slug = slugifySkillName(name)
    const path = join(this.root, slug, "SKILL.md")
    if (!existsSync(path)) return null
    const raw = readFileSync(path, "utf-8")
    const { meta, body } = parseFrontmatter(raw)
    const now = new Date().toISOString()
    const full: SkillMeta = {
      name: meta.name ?? slug,
      description: meta.description ?? "",
      version: meta.version ?? 1,
      created_at: meta.created_at ?? now,
      updated_at: meta.updated_at ?? now,
      usage_count: meta.usage_count ?? 0,
      source: meta.source ?? "unknown",
      tags: meta.tags,
    }
    return { meta: full, body, path }
  }

  /**
   * Create a brand-new skill. Throws if it already exists (use update()).
   * Returns the created skill.
   */
  create(input: {
    name: string
    description: string
    body: string
    source?: string
    tags?: string[]
  }): Skill {
    const slug = slugifySkillName(input.name)
    if (this.has(slug)) {
      throw new Error(`Skill "${slug}" already exists`)
    }
    const now = new Date().toISOString()
    const meta: SkillMeta = {
      name: slug,
      description: input.description,
      version: 1,
      created_at: now,
      updated_at: now,
      usage_count: 0,
      source: input.source ?? "conversation-reflection",
      tags: input.tags,
    }
    const path = join(this.root, slug, "SKILL.md")
    mkdirSync(join(this.root, slug), { recursive: true })
    writeFileSync(path, serializeFrontmatter(meta, input.body), "utf-8")
    return { meta, body: input.body.trim(), path }
  }

  /**
   * Update an existing skill's body and/or description, bumping the version
   * and updated_at. Throws if the skill does not exist.
   */
  update(
    name: string,
    changes: { description?: string; body?: string; tags?: string[] },
  ): Skill {
    const existing = this.get(name)
    if (!existing) {
      throw new Error(`Skill "${name}" does not exist`)
    }
    const meta: SkillMeta = {
      ...existing.meta,
      description: changes.description ?? existing.meta.description,
      tags: changes.tags ?? existing.meta.tags,
      version: existing.meta.version + 1,
      updated_at: new Date().toISOString(),
    }
    const body = (changes.body ?? existing.body).trim()
    writeFileSync(existing.path, serializeFrontmatter(meta, body), "utf-8")
    return { meta, body, path: existing.path }
  }

  /** Increment usage_count for a skill (Bayesian "the more used, the sharper"). */
  recordUsage(name: string): void {
    const existing = this.get(name)
    if (!existing) return
    const meta: SkillMeta = {
      ...existing.meta,
      usage_count: existing.meta.usage_count + 1,
      updated_at: new Date().toISOString(),
    }
    writeFileSync(existing.path, serializeFrontmatter(meta, existing.body), "utf-8")
  }
}
