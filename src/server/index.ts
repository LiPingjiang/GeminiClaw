// src/server/index.ts
import Fastify, { type FastifyInstance } from "fastify"
import type { Config } from "../config/schema.js"
import type { ProviderRouter } from "../providers/router.js"
import type { MemoryStrategy } from "../memory/strategy.js"
import type { EvolutionEngine } from "../evolution/index.js"
import { AgentLoop, type ChatFn, type InternalMessage, type ToolRegistryLike } from "../agent/index.js"
import { registry } from "../tools/index.js"
import type { ToolResult as AgentToolResult } from "../agent/types.js"
import { healthRoute } from "./routes/health.js"
import { chatRoute } from "./routes/chat.js"
import { evolutionRoute } from "./routes/evolution.js"
import { runsRoute } from "./routes/runs.js"
import { qqbotRoute } from "../channels/qqbot/index.js"
import { RunStore } from "./routes/run-store.js"

// Adapt ToolRegistry (2-arg handler, rich ToolResult) to ToolRegistryLike (1-arg handler, simple ToolResult)
function makeRegistryAdapter(): ToolRegistryLike {
  return {
    get(name: string) {
      const entry = registry.get(name)
      if (!entry) return null
      return {
        handler: async (args: Record<string, unknown>): Promise<AgentToolResult> => {
          const ctx = { sessionId: "", workdir: process.cwd(), logger: { info: () => undefined, warn: () => undefined, error: () => undefined } }
          const result = await entry.handler(args, ctx)
          if (result.type === "error") {
            return { content: result.error, isError: true }
          }
          return { content: result.text }
        },
        schema: entry.schema,
        executionMode: entry.executionMode,
      }
    },
    list() {
      return registry.list().map(t => ({
        name: t.name,
        description: t.description,
        schema: t.schema,
        executionMode: t.executionMode,
      }))
    },
  }
}

export async function buildServer(
  config: Config,
  router: ProviderRouter,
  strategy: MemoryStrategy,
  evolution?: EvolutionEngine,
): Promise<FastifyInstance> {
  const fastify = Fastify({ logger: false })

  // Wrap ProviderRouter.chat as ChatFn for AgentLoop
  const chatFn: ChatFn = async (messages: InternalMessage[], options?: { model?: string; tools?: unknown[] }) => {
    // tool role messages → user messages (ProviderRouter only handles user/assistant/system)
    const providerMessages = messages.map(m => {
      if (m.role === "tool") {
        return { role: "user" as const, content: `[Tool result for ${m.tool_call_id}]: ${m.content}` }
      }
      return { role: m.role as "user" | "assistant" | "system", content: m.content }
    })
    const response = await router.chat(providerMessages, options ? { model: options.model } : undefined)
    return { content: response.content }
  }

  const agentLoop = new AgentLoop({
    chatFn,
    toolRegistry: makeRegistryAdapter(),
    config: {
      maxTurns: config.agent.maxTurns,
      systemPrompt: config.agent.systemPrompt,
    },
    logger: { debug: () => undefined, error: console.error },
  })

  await fastify.register(healthRoute)
  await fastify.register(chatRoute, {
    router,
    strategy,
    authToken: config.server.authToken,
    evolution,
    agentLoop,
  })

  if (evolution) {
    await fastify.register(evolutionRoute, { evolution })
  }

  const runStore = new RunStore()
  await fastify.register(runsRoute, { runStore })

  const qqbotConfig = config.channels?.qqbot
  if (qqbotConfig?.enabled) {
    await fastify.register(qqbotRoute, {
      router,
      strategy,
      webhookPath: qqbotConfig.webhookPath ?? "/webhook/qqbot",
      appId: qqbotConfig.appId ?? "",
      clientSecret: qqbotConfig.clientSecret ?? "",
    })
  }

  return fastify
}
