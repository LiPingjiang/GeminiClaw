// src/server/index.ts
import Fastify, { type FastifyInstance } from "fastify";
import type { Db } from "../db/client.js";
import type { Config } from "../config/schema.js";
import type { ProviderRouter } from "../providers/router.js";
import type { MemoryStrategy } from "../memory/strategy.js";
import type { TwinSystemInstance } from "../twin-system/factory.js";
import { healthRoute } from "./routes/health.js";
import { evolutionRoute } from "./routes/evolution.js";
import { approvalRoute } from "./routes/approvals.js";
import { chatRoute } from "./routes/chat.js";
import { streamRoute } from "./routes/stream.js";
import { AgentLoop } from "../agent/index.js";
import { registry as toolRegistry } from "../tools/index.js";
import { ChannelRegistry } from "../channels/registry.js";
import type { IChannel } from "../channels/types.js"
import { QQBotChannel } from "../channels/qqbot/index.js";

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

  const chatFn = async (
    messages: Array<{
      role: string;
      content: string;
      tool_calls?: Array<{ id: string; name: string; args: Record<string, unknown> }>;
      tool_call_id?: string;
    }>,
    options?: {
      model?: string;
      tools?: Array<{
        name: string;
        description: string;
        input_schema: Record<string, unknown>;
      }>;
    },
  ) => {
    const providerMessages = messages.map((m) => {
      if (m.role === "tool")
        return {
          role: "tool" as const,
          content: m.content,
          tool_call_id: m.tool_call_id,
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
      providerMessages,
      options ? { model: options.model, tools: providerTools } : undefined,
    );

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

    return { content: response.content ?? "", tool_calls: agentToolCalls };
  };

  const agentLoop = new AgentLoop({
    chatFn: chatFn as any,
    toolRegistry: makeRegistryAdapter() as any,
    config: {
      maxTurns: (config.agent as { maxTurns?: number } | undefined)?.maxTurns ?? 20,
      systemPrompt: (config.agent as { systemPrompt?: string } | undefined)?.systemPrompt,
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

  // Evolution routes (twin-system based)
  if (twinSystem) {
    await fastify.register(evolutionRoute, { twinSystem });
    await fastify.register(approvalRoute, { approvalGate: twinSystem.approvalGate });
  }
  await fastify.register(chatRoute, {
    router,
    strategy,
    authToken: config.server.authToken,
    agentLoop,
    twinSystem,
  });

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
  });

  fastify.addHook("onClose", async () => {
    await chanRegistry.stopAll();
  });

  return fastify;
}
