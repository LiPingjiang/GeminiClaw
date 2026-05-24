// src/templates/manager.ts
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  cpSync,
  statSync,
} from "fs"
import { join, isAbsolute } from "path"
import os from "os"
import yaml from "js-yaml"
import { templateMetaSchema, type TemplateMeta } from "./schema.js"
import type { Config } from "../config/schema.js"

export interface TemplateInfo {
  meta: TemplateMeta
  agentMdPath: string
  skillsDir: string
}

/**
 * TemplateManager — manages agent templates under ~/.gemeniclaw/templates/
 *
 * Directory layout:
 *   ~/.gemeniclaw/templates/
 *   ├── base/
 *   │   ├── template.yaml
 *   │   ├── AGENT.md
 *   │   └── skills/
 *   └── <name>/
 *       ├── template.yaml
 *       ├── AGENT.md   (optional)
 *       └── skills/    (optional)
 */
export class TemplateManager {
  readonly templatesDir: string

  constructor(templatesDir?: string) {
    this.templatesDir =
      templatesDir ?? join(os.homedir(), ".gemeniclaw", "templates")
  }

  // ── Directory helpers ──────────────────────────────────────────────────────

  private templateDir(name: string): string {
    return join(this.templatesDir, name)
  }

  private metaPath(name: string): string {
    return join(this.templateDir(name), "template.yaml")
  }

  // ── Read helpers ───────────────────────────────────────────────────────────

  private readMeta(name: string): TemplateMeta | null {
    const p = this.metaPath(name)
    if (!existsSync(p)) return null
    try {
      const raw = yaml.load(readFileSync(p, "utf-8"))
      const result = templateMetaSchema.safeParse(raw)
      if (!result.success) {
        console.warn(`[templates] Invalid template.yaml for "${name}":`, result.error.message)
        return null
      }
      return result.data
    } catch (e) {
      console.warn(`[templates] Failed to read template.yaml for "${name}":`, e)
      return null
    }
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * List all templates (scan templatesDir, read each template.yaml).
   */
  list(): TemplateMeta[] {
    if (!existsSync(this.templatesDir)) return []
    const entries = readdirSync(this.templatesDir, { withFileTypes: true })
    const results: TemplateMeta[] = []
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const meta = this.readMeta(entry.name)
      if (meta) results.push(meta)
    }
    return results
  }

  /**
   * Get a single template info by name.
   */
  get(name: string): TemplateInfo | null {
    const meta = this.readMeta(name)
    if (!meta) return null
    return {
      meta,
      agentMdPath: join(this.templateDir(name), "AGENT.md"),
      skillsDir: join(this.templateDir(name), "skills"),
    }
  }

  /**
   * Copy a template (src → dst). Copies template.yaml + AGENT.md (if any) + skills/ (if any).
   * Fully independent, no parent-child relationship maintained.
   */
  copy(src: string, dst: string): void {
    const srcDir = this.templateDir(src)
    const dstDir = this.templateDir(dst)

    if (!existsSync(srcDir)) {
      throw new Error(`Source template not found: ${src}`)
    }
    if (existsSync(dstDir)) {
      throw new Error(`Destination template already exists: ${dst}`)
    }

    mkdirSync(dstDir, { recursive: true })

    // Copy template.yaml (update name and copied_from)
    const srcMeta = this.readMeta(src)
    if (!srcMeta) throw new Error(`Cannot read template.yaml for: ${src}`)

    const dstMeta: TemplateMeta = {
      ...srcMeta,
      name: dst,
      copied_from: src,
      created_at: new Date().toISOString(),
    }
    // Remove display_name so it stays undefined (user should set it)
    delete dstMeta.display_name

    writeFileSync(
      join(dstDir, "template.yaml"),
      yaml.dump(dstMeta, { lineWidth: 100 }),
      "utf-8"
    )

    // Copy AGENT.md if it exists
    const srcAgentMd = join(srcDir, "AGENT.md")
    if (existsSync(srcAgentMd)) {
      const content = readFileSync(srcAgentMd, "utf-8")
      writeFileSync(join(dstDir, "AGENT.md"), content, "utf-8")
    }

    // Copy skills/ if it exists
    const srcSkillsDir = join(srcDir, "skills")
    if (existsSync(srcSkillsDir) && statSync(srcSkillsDir).isDirectory()) {
      cpSync(srcSkillsDir, join(dstDir, "skills"), { recursive: true })
    }
  }

  /**
   * Ensure the base template exists (idempotent — only creates if missing).
   */
  ensureBase(config?: Config): void {
    const baseDir = this.templateDir("base")
    const metaFilePath = this.metaPath("base")

    mkdirSync(baseDir, { recursive: true })
    mkdirSync(join(baseDir, "skills"), { recursive: true })

    // Write template.yaml only if missing
    if (!existsSync(metaFilePath)) {
      const baseMeta: TemplateMeta = {
        name: "base",
        display_name: "通用助手",
        description: "基础通用模板，了解当前机器的配置、代码路径等基础信息",
        keywords: ["通用", "基础", "帮助"],
        created_at: new Date().toISOString(),
      }
      writeFileSync(metaFilePath, yaml.dump(baseMeta, { lineWidth: 100 }), "utf-8")
      console.log(`[templates] Created base template metadata: ${metaFilePath}`)
    }

    // Write AGENT.md only if missing
    const agentMdPath = join(baseDir, "AGENT.md")
    if (!existsSync(agentMdPath)) {
      const agentMdContent = config
        ? this._renderAgentMd(config)
        : this._defaultAgentMd()
      writeFileSync(agentMdPath, agentMdContent, "utf-8")
      console.log(`[templates] Created base template AGENT.md: ${agentMdPath}`)
    }
  }

  /**
   * Read a template's AGENT.md content.
   */
  loadAgentMd(templateName: string): string | null {
    const p = join(this.templateDir(templateName), "AGENT.md")
    if (!existsSync(p)) return null
    return readFileSync(p, "utf-8")
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  /**
   * Render AGENT.md from the project's AGENT.md.template (same logic as memory/strategy.ts).
   */
  private _renderAgentMd(config: Config): string {
    const cwd = process.cwd()
    const templatePath = join(cwd, "AGENT.md.template")
    if (!existsSync(templatePath)) return this._defaultAgentMd()

    const qqbotCfg = config.channels?.qqbot
    const channelsDesc = qqbotCfg?.enabled
      ? `- **QQ Bot（C2C 私聊）：** WebSocket 长连接模式，AppID \`${qqbotCfg.appId}\``
      : "- 暂无已启用的渠道"

    const userDataDir = join(os.homedir(), ".gemeniclaw")
    const vars: Record<string, string> = {
      HOSTNAME: os.hostname(),
      USER: os.userInfo().username,
      CWD: cwd,
      PORT: String(config.server?.port ?? 18888),
      WORKSPACE_DIR: join(cwd, config.workspace?.dir ?? ".workspace"),
      MEMORY_DATA_DIR: isAbsolute(config.memory?.dataDir ?? "")
        ? config.memory.dataDir
        : join(os.homedir(), ".gemeniclaw", "memory"),
      SKILLS_DIR: join(os.homedir(), ".gemeniclaw", "skills"),
      CONFIG_PATH: join(os.homedir(), ".gemeniclaw", "config.yaml"),
      USER_DATA_DIR: userDataDir,
      MEMORY_STRATEGY: config.memory?.strategy ?? "buffer",
      DEFAULT_MODEL: config.routing?.default ?? "（未配置）",
      MAX_TURNS: String(config.agent?.maxTurns ?? 20),
      TIMEOUT: String(config.agent?.timeoutSeconds ?? 60),
      CHANNELS_DESC: channelsDesc,
    }

    let content = readFileSync(templatePath, "utf-8")
    for (const [key, val] of Object.entries(vars)) {
      content = content.replaceAll(`{{${key}}}`, val)
    }
    return content.trim()
  }

  /**
   * Fallback AGENT.md content when no template file is present.
   */
  private _defaultAgentMd(): string {
    return `# AGENT.md — GeminiClaw 通用助手

你是 **GeminiClaw**，一个智能 AI Agent。

## 基础信息

- **宿主机器：** ${os.hostname()}
- **运行用户：** ${os.userInfo().username}
- **模板目录：** ${this.templatesDir}

## 能力

- 回答问题、完成任务
- 调用工具执行代码或查询信息
- 记忆上下文，连续对话

## 注意事项

这是 base 模板的默认 AGENT.md。你可以编辑 \`${this.templateDir("base")}/AGENT.md\` 来自定义。
`.trim()
  }
}

// Singleton for application-wide use
export const templateManager = new TemplateManager()
