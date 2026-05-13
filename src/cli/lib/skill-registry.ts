import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs"
import { join } from "path"

export interface SkillRegistryEntry {
  source: string           // "github:obra/superpowers" | "mt-skillhub:<name>" | "local"
  installedAt: string      // ISO 8601
  version: string | null
  updateUrl: string | null
}

export interface SkillRegistryData {
  version: number
  skills: Record<string, SkillRegistryEntry>
}

const REGISTRY_FILE = ".registry.json"

export class SkillRegistry {
  private skillsDir: string
  private data: SkillRegistryData

  constructor(skillsDir: string) {
    this.skillsDir = skillsDir
    this.data = this.load()
  }

  private registryPath(): string {
    return join(this.skillsDir, REGISTRY_FILE)
  }

  private load(): SkillRegistryData {
    const path = this.registryPath()
    if (!existsSync(path)) {
      return { version: 1, skills: {} }
    }
    try {
      return JSON.parse(readFileSync(path, "utf-8")) as SkillRegistryData
    } catch {
      return { version: 1, skills: {} }
    }
  }

  private save(): void {
    mkdirSync(this.skillsDir, { recursive: true })
    writeFileSync(
      this.registryPath(),
      JSON.stringify(this.data, null, 2),
      "utf-8"
    )
  }

  register(
    name: string,
    opts: { source: string; version?: string; updateUrl?: string }
  ): void {
    this.data.skills[name] = {
      source: opts.source,
      installedAt: new Date().toISOString(),
      version: opts.version ?? null,
      updateUrl: opts.updateUrl ?? null,
    }
    this.save()
  }

  get(name: string): SkillRegistryEntry | undefined {
    return this.data.skills[name]
  }

  list(): Array<{ name: string } & SkillRegistryEntry> {
    return Object.entries(this.data.skills).map(([name, entry]) => ({
      name,
      ...entry,
    }))
  }

  groupBySource(): Record<string, Array<{ name: string } & SkillRegistryEntry>> {
    const groups: Record<string, Array<{ name: string } & SkillRegistryEntry>> = {}
    for (const item of this.list()) {
      if (!groups[item.source]) groups[item.source] = []
      groups[item.source].push(item)
    }
    return groups
  }
}
