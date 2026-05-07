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
import { completionsRoute } from "./routes/completions.js"
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

  // CORS — allow all origins for local dev
  // Must use onRequest (not onSend) because SSE routes use reply.hijack()
  // which bypasses Fastify's reply pipeline entirely.
  fastify.addHook('onRequest', async (request, reply) => {
    reply.header('Access-Control-Allow-Origin', '*')
    reply.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
    reply.header('Access-Control-Allow-Headers', 'Authorization,Content-Type')
    if (request.method === 'OPTIONS') {
      reply.status(204).send()
    }
  })

  // Wrap ProviderRouter.chat as ChatFn for AgentLoop
  const chatFn: ChatFn = async (messages: InternalMessage[], options?: { model?: string; tools?: unknown[] }) => {
    // Convert InternalMessage to provider Message format.
    // assistant messages with tool_calls need function.arguments serialized.
    // tool messages pass through with tool_call_id.
    type ProviderMsg = import('../providers/types.js').Message
    const providerMessages: ProviderMsg[] = messages.map(m => {
      if (m.role === 'tool') {
        return { role: 'tool' as const, content: m.content, tool_call_id: m.tool_call_id }
      }
      if (m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0) {
        // Convert agent tool_calls (flat) back to OpenAI format for the provider
        return {
          role: 'assistant' as const,
          content: m.content,
          tool_calls: m.tool_calls.map(tc => ({
            id: tc.id,
            type: 'function' as const,
            function: { name: tc.name, arguments: JSON.stringify(tc.args) },
          })),
        }
      }
      return { role: m.role as 'user' | 'assistant' | 'system', content: m.content }
    })
    // Convert AgentLoop tool schema format (Anthropic: input_schema)
    // to OpenAI-compatible format (function: { name, description, parameters })
    // which Friday and mcli providers expect.
    type AgentTool = { name: string; description: string; input_schema: unknown }
    const providerTools = options?.tools
      ? (options.tools as AgentTool[]).map(t => ({
          type: 'function' as const,
          function: {
            name: t.name,
            description: t.description,
            parameters: t.input_schema as Record<string, unknown>,
          },
        }))
      : undefined

    const response = await router.chat(providerMessages, options ? { model: options.model, tools: providerTools } : undefined)

    // Convert provider tool_calls (OpenAI format: function.name + function.arguments string)
    // back to AgentLoop format (flat: name + args object)
    type ProviderToolCall = { id: string; type: string; function: { name: string; arguments: string } }
    const agentToolCalls = response.tool_calls
      ? (response.tool_calls as unknown as ProviderToolCall[]).map(tc => ({
          id: tc.id,
          name: tc.function.name,
          args: (() => { try { return JSON.parse(tc.function.arguments) } catch { return {} } })(),
        }))
      : undefined

    return { content: response.content ?? '', tool_calls: agentToolCalls }
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
  await fastify.register(completionsRoute, {
    router,
    authToken: config.server.authToken,
  })
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
  await fastify.register(runsRoute, {
    runStore,
    agentLoop,
    sessionStore: strategy,
    authToken: config.server.authToken,
  })

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
