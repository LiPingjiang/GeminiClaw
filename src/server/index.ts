// src/server/index.ts
import Fastify, { type FastifyInstance } from "fastify";
import type { Db } from "../db/client.js";
import type { Config } from "../config/schema.js";
import type { ProviderRouter } from "../providers/router.js";
import type { MemoryStrategy } from "../memory/strategy.js";
import { loadSystemPrompt } from "../memory/strategy.js";
import type { TwinSystemInstance } from "../twin-system/factory.js";
import { healthRoute } from "./routes/health.js";
import { evolutionRoute } from "./routes/evolution.js";
import { skillEvolutionRoute } from "./routes/skill-evolution.js";
import { approvalRoute } from "./routes/approvals.js";
import { chatRoute } from "./routes/chat.js";
import { streamRoute } from "./routes/stream.js"
import { traceRoute } from "./routes/trace.js";
import { AgentLoop } from "../agent/index.js";
import { registry as toolRegistry } from "../tools/index.js";
import { ChannelRegistry } from "../channels/registry.js";
import type { IChannel } from "../channels/types.js"
import { QQBotChannel } from "../channels/qqbot/index.js";
import { registerStatic } from './static.js'
import { sessionsRoute } from './routes/sessions.js'
import { agentsRoute } from './routes/agents.js'
import { runsRoute } from './routes/runs.js'
import { RunStore } from './routes/run-store.js'
import { localConfigRoute } from './routes/localconfig.js'
import { modelsRoute } from './routes/models.js'

function makeRegistryAdapter() {
  return {
    get(name: string) {
      const entry = toolRegistry.get(name);
      if (!entry) return null;
      return {
        handler: async (
          args: Record<string, unknown>,
          outerCtx?: {
            sessionId?: string;
            workdir?: string;
            logger?: {
              info: (...a: unknown[]) => void;
              warn: (...a: unknown[]) => void;
              error: (...a: unknown[]) => void;
            };
            extra?: Record<string, unknown>;
          },
        ) => {
          const ctx = {
            sessionId: outerCtx?.sessionId ?? "",
            workdir: outerCtx?.workdir ?? process.cwd(),
            logger: outerCtx?.logger ?? {
              info: () => undefined,
              warn: () => undefined,
              error: () => undefined,
            },
            extra: outerCtx?.extra,
          };
          const result = await entry.handler(args, ctx);
          if (result.type === "error")
            return { content: result.error, isError: true };
          if (result.type === "multimodal")
            return { content: result.textSummary, multimodal: result.content };
          return { content: result.text };
        },
        schema: entry.schema,
        executionMode: entry.executionMode,
      };
    },
    list() {
      return toolRegistry.list().map((t) => ({
        name: t.name,
        description: t.description,
        schema: t.schema,
        executionMode: t.executionMode,
      }));
    },
  };
}

export async function buildServer(
  config: Config,
  router: ProviderRouter,
  strategy: MemoryStrategy,
  db?: Db,
  twinSystem?: TwinSystemInstance,
): Promise<FastifyInstance> {
  const fastify = Fastify({ logger: false });

  // Track the last fallback route used (shared across chatFn calls)
  let _lastFallbackRoute: string | undefined;

  /** Get and reset the last fallback route (call after agentLoop.run completes) */
  function consumeFallbackRoute(): string | undefined {
    const route = _lastFallbackRoute;
    _lastFallbackRoute = undefined;
    return route;
  }

  const chatFn = async (
    messages: Array<{
      role: string;
      content: string | Array<{ type: string; text?: string; image_url?: { url: string; detail?: string } }>;
      tool_calls?: Array<{ id: string; name: string; args: Record<string, unknown> }>;
      tool_call_id?: string;
      multimodal?: Array<{ type: string; text?: string; image_url?: { url: string; detail?: string } }>;
    }>,
    options?: {
      model?: string;
      tools?: Array<{
        name: string;
        description: string;
        input_schema: Record<string, unknown>;
      }>;
      thinking?: { type: 'enabled'; budget_tokens: number };
    },
  ) => {
    const providerMessages = messages.map((m) => {
      if (m.role === "tool")
        return {
          role: "tool" as const,
          content: m.content,
          tool_call_id: m.tool_call_id,
          // Pass through multimodal content for vision-capable providers
          ...(m.multimodal ? { multimodal: m.multimodal } : {}),
        };
      if (
        m.role === "assistant" &&
        m.tool_calls &&
        m.tool_calls.length > 0
      ) {
        return {
          role: "assistant" as const,
          content: m.content,
          tool_calls: m.tool_calls.map((tc) => ({
            id: tc.id,
            type: "function" as const,
            function: {
              name: tc.name,
              arguments: JSON.stringify(tc.args),
            },
          })),
        };
      }
      return { role: m.role as "user" | "system" | "assistant", content: m.content };
    });

    const providerTools = options?.tools
      ? options.tools.map((t) => ({
          type: "function" as const,
          function: {
            name: t.name,
            description: t.description,
            parameters: t.input_schema,
          },
        }))
      : undefined;

    const response = await router.chat(
      providerMessages as import("../providers/types.js").Message[],
      options ? { model: options.model, tools: providerTools, ...(options.thinking ? { thinking: options.thinking } : {}) } : undefined,
    );

    // Track fallback route for downstream consumers (QQBot channel etc.)
    if (response.routeUsed) {
      _lastFallbackRoute = response.routeUsed;
    }

    const agentToolCalls = response.tool_calls
      ? response.tool_calls.map((tc: {
          id: string;
          function: { name: string; arguments: string };
        }) => ({
          id: tc.id,
          name: tc.function.name,
          args: (() => {
            try {
              return JSON.parse(tc.function.arguments) as Record<string, unknown>;
            } catch {
              return {} as Record<string, unknown>;
            }
          })(),
        }))
      : undefined;

    return { content: response.content ?? "", tool_calls: agentToolCalls, model: response.model, usage: response.usage, stopReason: response.stopReason };
  };

  const agentLoop = new AgentLoop({
    chatFn: chatFn as any,
    toolRegistry: makeRegistryAdapter() as any,
    config: {
      maxTurns: (config.agent as { maxTurns?: number } | undefined)?.maxTurns ?? 50,
      systemPrompt: loadSystemPrompt(config.routing.default),
      // 工具调用守护：同一工具连续失败/无进展时 warn/halt
      guardrails: {
        sameToolFailureWarnAfter: 3,
        sameToolFailureHaltAfter: 8,
        noProgressWarnAfter: 2,
        noProgressHaltAfter: 5,
      },
    },
    logger: { debug: () => undefined, error: console.error },
  });

  await fastify.register(healthRoute, { twinSystem });
  await fastify.register(localConfigRoute, { authToken: config.server.authToken });
  await fastify.register(modelsRoute, { router, authToken: config.server.authToken });

  // Evolution routes (twin-system based / code engine)
  if (twinSystem) {
    await fastify.register(evolutionRoute, { twinSystem });
    await fastify.register(approvalRoute, { approvalGate: twinSystem.approvalGate });
  }
  // Skill evolution routes (Hermes-style skill engine)
  if (db) {
    await fastify.register(skillEvolutionRoute, { db });
  }
  await fastify.register(chatRoute, {
    router,
    strategy,
    authToken: config.server.authToken,
    agentLoop,
    twinSystem,
    db,
  });

  // Trace live route — QQBot 对话实时监控（gc watch）
  await fastify.register(traceRoute)

  // TUI stream route — AgentLoop 原生事件 SSE 流
  await fastify.register(streamRoute, {
    router,
    strategy,
    authToken: config.server.authToken,
    agentLoop: agentLoop as AgentLoop,
  });

  // Channel framework — start QQBot if configured, pass db for GuidanceLayer
  const chanRegistry = new ChannelRegistry();
  const qqbotConfig = (config as { channels?: { qqbot?: { enabled?: boolean } } })
    .channels?.qqbot;
  if (qqbotConfig?.enabled) {
    chanRegistry.register(
      new QQBotChannel(
        qqbotConfig as any,
        fastify,
        db ?? undefined,
      ) as any,
    );
  }
  await chanRegistry.startAll({
    router,
    memory: strategy,
    agentLoop,
    config,
    twinSystem,
    consumeFallbackRoute,
  });

  fastify.addHook("onClose", async () => {
    await chanRegistry.stopAll();
  });

  // REST API routes for sessions, agents, runs
  if (db) {
    await fastify.register(sessionsRoute, { db, authToken: config.server.authToken })
    await fastify.register(agentsRoute, { db, authToken: config.server.authToken })
  }
  const runStore = new RunStore()
  await fastify.register(runsRoute, {
    runStore,
    router,
    strategy,
    authToken: config.server.authToken,
    agentLoop: agentLoop as any,
  })

  // Web UI static files (served from web/dist/ after pnpm build:web)
  await registerStatic(fastify)

  return fastify;
}
