// src/index.ts
import { loadConfig } from "./config/loader.js"
import { AnthropicProvider } from "./providers/anthropic.js"
import { McliProvider } from "./providers/mcli.js"
import { FridayProvider } from "./providers/friday.js"
import { ProviderRouter } from "./providers/router.js"
import { buildStrategy } from "./memory/strategy.js"
import { buildServer } from "./server/index.js"
import { openDb } from "./db/client.js"
import { migrate } from "./db/schema.js"
import { join, resolve } from "path"
import { mkdirSync, readFileSync, existsSync } from "fs"
import { EvolutionEngine, EvolutionDB } from "./evolution/index.js"
import type { Provider } from "./providers/types.js"
import type { ProviderConfig } from "./config/schema.js"

function buildProvider(config: ProviderConfig): Provider {
  switch (config.type) {
    case "anthropic":
      return new AnthropicProvider(config)
    case "mcli":
      return new McliProvider(config)
    case "friday":
      return new FridayProvider(config)
    default:
      throw new Error(`Unsupported provider type: ${config.type}`)
  }
}

/**
 * 构建系统提示词：加载 .workspace/SOUL.md（如果存在）+ 注入真实配置信息，
 * 防止 LLM 根据名字「GeminiClaw」脑补出错误的模型名称。
 */
function buildSystemPrompt(config: ReturnType<typeof loadConfig>): string {
  const workspaceDir = resolve(process.cwd(), ".workspace")
  const soulPath = join(workspaceDir, "SOUL.md")
  const soulContent = existsSync(soulPath) ? readFileSync(soulPath, "utf-8") : ""

  // 从 routing 配置中提取真实模型列表
  const defaultModel = config.routing.default ?? "（未配置）"
  const fallbackModels = config.routing.fallback ?? []
  const allModels = [defaultModel, ...fallbackModels].filter((v, i, a) => a.indexOf(v) === i)

  const groundingFacts = [
    "## GeminiClaw 运行时信息（真实配置，不得编造）",
    `- **当前默认模型**：${defaultModel}`,
    fallbackModels.length > 0 ? `- **备用模型**：${fallbackModels.join("、")}` : "",
    `- **服务端口**：${config.server.port}`,
    `- **记忆数据库**：${config.memory.dataDir}/geminiclaw.db`,
    "",
    "## 重要行为准则",
    "- 被问到「你用的是什么模型」时，**直接引用上面的配置信息回答**，不要编造模型名称",
    "- 你不是 Google Gemini，不是 OpenAI GPT；你是 GeminiClaw Agent，底层模型见上方配置",
    `- 可用模型完整列表：${allModels.join("、")}`,
    "- 被问到其他配置细节时，用 read 工具查看 config.yaml 获取真实信息，不要靠推断",
  ].filter(Boolean).join("\n")

  return soulContent ? `${soulContent}\n\n${groundingFacts}` : groundingFacts
}

async function main(): Promise<void> {
  const config = loadConfig()

  // 系统提示词：config.yaml 没有设置时，从 .workspace/SOUL.md 动态加载并注入真实模型信息
  if (!config.agent.systemPrompt) {
    config.agent.systemPrompt = buildSystemPrompt(config)
    const modelLine = `默认模型: ${config.routing.default}`
    console.log(`[SystemPrompt] 从 .workspace/SOUL.md 加载，${modelLine}`)
  }

  // Provider 初始化
  const providers = config.providers.map(buildProvider)
  const router = new ProviderRouter(providers, config.routing)

  // DB 初始化（layered 策略需要）
  const dbPath = join(config.memory.dataDir, "geminiclaw.db")
  const db = openDb(dbPath)
  migrate(db)

  // 路由 provider（friday，用于 layered 策略的摘要/路由）
  const routerProvider = providers.find(p => p.name === "friday") ?? null

  // 记忆策略
  const strategy = buildStrategy(config, db, routerProvider)

  // Evolution Engine 初始化
  const evolutionDataDir = join(config.memory.dataDir, "evolution")
  mkdirSync(evolutionDataDir, { recursive: true })
  const evolutionDb = new EvolutionDB(join(evolutionDataDir, "gemini-evolution.db"))
  const evolution = new EvolutionEngine({
    db: evolutionDb,
    providerRouter: router,
    repoRoot: process.cwd(),
    memoryDbPath: dbPath,
  })
  await evolution.start()

  const server = await buildServer(config, router, strategy, evolution)

  await server.listen({ port: config.server.port, host: config.server.host })
  console.log(`GeminiClaw listening on ${config.server.host}:${config.server.port}`)
  console.log(`Memory strategy: ${strategy.name}`)
}

main().catch(err => {
  console.error("Fatal error:", err)
  process.exit(1)
})
