import type { Message } from "../providers/types.js"
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "fs"
import { join, isAbsolute } from "path"
import os from "os"

export interface ConversationContext {
  /** 注入给主模型的消息列表（含 system、历史、当前消息前的所有内容） */
  messages: Message[]
  /** 调试/日志用：使用了哪个策略 */
  strategyName: string
}

export interface MemoryStrategy {
  readonly name: string
  /** 确保 session 存在（幂等） */
  ensureSession(sessionId: string): Promise<void>
  /** 根据当前用户消息，组装注入主模型的 context */
  getContext(sessionId: string, userMessage: string): Promise<ConversationContext>
  /** 主模型回复后，追加本轮对话并触发后台异步处理 */
  appendTurn(sessionId: string, userMsg: Message, assistantMsg: Message): Promise<void>
}

import type { Config } from "../config/schema.js"
import type { Db } from "../db/client.js"
import type { Provider } from "../providers/types.js"
import { BufferStrategy } from "./strategies/buffer.js"
import { LayeredStrategy } from "./strategies/layered.js"
import { SqliteStrategy } from "./strategies/sqlite.js"
import { CompactionStrategy } from "./strategies/compaction.js"

function resolveDir(base: string, dir: string): string {
  return isAbsolute(dir) ? dir : join(base, dir)
}

function generateAgentMd(config: Config): string {
  const cwd = process.cwd()
  const templatePath = join(cwd, 'AGENT.md.template')
  if (!existsSync(templatePath)) {
    return DEFAULT_SYSTEM_PROMPT_FALLBACK
  }

  const qqbotCfg = config.channels?.qqbot
  const channelsDesc = qqbotCfg?.enabled
    ? `- **QQ Bot（C2C 私聊）：** WebSocket 长连接模式，AppID \`${qqbotCfg.appId}\``
    : '- 暂无已启用的渠道'

  const vars: Record<string, string> = {
    HOSTNAME: os.hostname(),
    USER: os.userInfo().username,
    CWD: cwd,
    PORT: String(config.server?.port ?? 18888),
    WORKSPACE_DIR: resolveDir(cwd, config.workspace?.dir ?? '.workspace'),
    MEMORY_DATA_DIR: isAbsolute(config.memory?.dataDir ?? '')
      ? config.memory.dataDir
      : join(os.homedir(), '.gemeniclaw', 'memory'),
    SKILLS_DIR: join(os.homedir(), '.gemeniclaw', 'skills'),
    CONFIG_PATH: join(os.homedir(), '.gemeniclaw', 'config.yaml'),
    USER_DATA_DIR: join(os.homedir(), '.gemeniclaw'),
    MEMORY_STRATEGY: config.memory?.strategy ?? 'buffer',
    DEFAULT_MODEL: config.routing?.default ?? '（未配置）',
    MAX_TURNS: String(config.agent?.maxTurns ?? 20),
    TIMEOUT: String(config.agent?.timeoutSeconds ?? 60),
    CHANNELS_DESC: channelsDesc,
  }

  let content = readFileSync(templatePath, 'utf-8')
  for (const [key, val] of Object.entries(vars)) {
    content = content.replaceAll(`{{${key}}}`, val)
  }
  return content.trim()
}

function loadSystemPrompt(config?: Config): string {
  const userDataDir = join(os.homedir(), '.gemeniclaw')
  const agentMdPath = join(userDataDir, 'AGENT.md')

  // 已有 AGENT.md，直接用
  if (existsSync(agentMdPath)) {
    console.log(`[memory] Loaded system prompt from ${agentMdPath}`)
    return readFileSync(agentMdPath, 'utf-8').trim()
  }

  // 没有 AGENT.md：尝试从模板生成并写入
  if (config) {
    const generated = generateAgentMd(config)
    if (generated !== DEFAULT_SYSTEM_PROMPT_FALLBACK) {
      mkdirSync(userDataDir, { recursive: true })
      writeFileSync(agentMdPath, generated, 'utf-8')
      console.log(`[memory] Generated AGENT.md from template → ${agentMdPath}`)
      return generated
    }
  }

  console.warn('[memory] AGENT.md not found and no template, using default system prompt')
  return DEFAULT_SYSTEM_PROMPT_FALLBACK
}

const DEFAULT_SYSTEM_PROMPT_FALLBACK = `你是 GeminiClaw，一个独立的 AI Agent 运行时，由李平江开发。

## 关于你的记忆

你的记忆存储在 SQLite 数据库中（/tmp/geminiclaw-test/geminiclaw.db），通过内置的 LayeredMemory 系统管理。
你的记忆包括：对话历史（chat_messages 表）、话题索引（memory_topics 表）。
当前对话的上下文会自动注入到你的 context 中，你无需主动查询数据库。

## 重要边界约束

- 你的工作目录是 /Users/lipingjiang/Codes/GeminiClaw
- 不要读取 ~/.claude/、~/claude-obsidian/、~/.openclaw/ 等其他 AI 工具的配置文件——那些不是你的记忆
- 不要用 exec 工具在文件系统中搜索记忆，不要读取与 GeminiClaw 无关的目录

## 回答风格
简洁、准确、直接。`

export function buildStrategy(
  config: Config,
  db: Db,
  routerProvider: Provider | null,
): MemoryStrategy {
  // Build the inner (storage) strategy first
  let innerStrategy: MemoryStrategy

  if (config.memory.strategy === "sqlite") {
    innerStrategy = new SqliteStrategy(db, config.memory.recentMessageLimit)
  } else if (config.memory.strategy === "layered" && routerProvider) {
    innerStrategy = new LayeredStrategy({
      db,
      routerProvider,
      triageProvider: routerProvider,
      systemPrompt: loadSystemPrompt(config),
      recentMessageLimit: config.memory.recentMessageLimit,
      triageAfterTurns: config.memory.triageAfterTurns,
      compactThresholdBytes: config.memory.compactThresholdBytes,
      maxActiveTopics: config.memory.maxActiveTopics,
    })
  } else {
    innerStrategy = new BufferStrategy({ recentMessageLimit: config.memory.recentMessageLimit })
  }

  // If compaction is enabled, wrap the inner strategy with CompactionStrategy
  if (config.memory.compaction?.enabled) {
    const threshold = config.memory.compactionThreshold ?? 0.75
    const contextWindow = config.memory.compactionContextWindow ?? 200000
    const keepLast = config.memory.compactionKeepLast ?? 20

    return new CompactionStrategy(innerStrategy, {
      threshold,
      contextWindow,
      keepLast,
      summarizeFn: async (messages, existingSummary) => {
        // Phase 2 placeholder — Phase 3 will call a real LLM
        const msgText = messages
          .map(m => `${m.role}: ${typeof m.content === 'string' ? m.content : JSON.stringify(m.content)}`)
          .join('\n')
        void msgText  // reserved for future LLM call
        return existingSummary
          ? `[之前摘要]\n${existingSummary}\n\n[新增内容摘要]\n对话历史（${messages.length}条）已压缩`
          : `对话历史（${messages.length}条）已压缩`
      },
    })
  }

  return innerStrategy
}
