// scripts/patch-server.mjs — patches dist/server/index.js after tsc build
// to restore AgentLoop + QQBot channel startup that's missing from the minimal src/
import { writeFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const outFile = join(__dirname, '..', 'dist', 'server', 'index.js')

const code = `// src/server/index.ts (patched: AgentLoop + QQBot channel startup)
import Fastify from "fastify";
import { healthRoute } from "./routes/health.js";
import { chatRoute } from "./routes/chat.js";
import { AgentLoop } from "../agent/index.js";
import { registry as toolRegistry } from "../tools/index.js";
import { ChannelRegistry } from "../channels/registry.js";
import { QQBotChannel } from "../channels/qqbot/index.js";

function makeRegistryAdapter() {
    return {
        get(name) {
            const entry = toolRegistry.get(name);
            if (!entry) return null;
            return {
                handler: async (args, outerCtx) => {
                    const ctx = {
                        sessionId: outerCtx?.sessionId ?? \"\",
                        workdir: outerCtx?.workdir ?? process.cwd(),
                        logger: outerCtx?.logger ?? { info: () => undefined, warn: () => undefined, error: () => undefined },
                        extra: outerCtx?.extra,
                    };
                    const result = await entry.handler(args, ctx);
                    if (result.type === \"error\") return { content: result.error, isError: true };
                    return { content: result.text };
                },
                schema: entry.schema,
                executionMode: entry.executionMode,
            };
        },
        list() {
            return toolRegistry.list().map(t => ({
                name: t.name,
                description: t.description,
                schema: t.schema,
                executionMode: t.executionMode,
            }));
        },
    };
}

export async function buildServer(config, router, strategy) {
    const fastify = Fastify({ logger: false });

    const chatFn = async (messages, options) => {
        const providerMessages = messages.map(m => {
            if (m.role === \"tool\") return { role: \"tool\", content: m.content, tool_call_id: m.tool_call_id };
            if (m.role === \"assistant\" && m.tool_calls && m.tool_calls.length > 0) {
                return {
                    role: \"assistant\", content: m.content,
                    tool_calls: m.tool_calls.map(tc => ({
                        id: tc.id, type: \"function\",
                        function: { name: tc.name, arguments: JSON.stringify(tc.args) },
                    })),
                };
            }
            return { role: m.role, content: m.content };
        });
        const providerTools = options?.tools
            ? options.tools.map(t => ({ type: \"function\", function: { name: t.name, description: t.description, parameters: t.input_schema } }))
            : undefined;
        const response = await router.chat(providerMessages, options ? { model: options.model, tools: providerTools } : undefined);
        const agentToolCalls = response.tool_calls
            ? response.tool_calls.map(tc => ({ id: tc.id, name: tc.function.name, args: (() => { try { return JSON.parse(tc.function.arguments); } catch { return {}; } })() }))
            : undefined;
        return { content: response.content ?? \"\", tool_calls: agentToolCalls };
    };

    const agentLoop = new AgentLoop({
        chatFn,
        toolRegistry: makeRegistryAdapter(),
        config: { maxTurns: config.agent?.maxTurns ?? 20, systemPrompt: config.agent?.systemPrompt },
        logger: { debug: () => undefined, error: console.error },
    });

    await fastify.register(healthRoute);
    await fastify.register(chatRoute, { router, strategy, authToken: config.server.authToken });

    // Channel framework
    const chanRegistry = new ChannelRegistry();
    const qqbotConfig = config.channels?.qqbot;
    if (qqbotConfig?.enabled) {
        chanRegistry.register(new QQBotChannel(qqbotConfig, fastify, null));
    }
    await chanRegistry.startAll({ router, memory: strategy, agentLoop, config });

    fastify.addHook(\"onClose\", async () => { await chanRegistry.stopAll(); });

    return fastify;
}
`

writeFileSync(outFile, code, 'utf-8')
console.log('✅ dist/server/index.js patched (AgentLoop + QQBot restored)')
