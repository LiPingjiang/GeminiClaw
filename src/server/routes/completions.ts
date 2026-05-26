// @ts-nocheck
// src/server/routes/completions.ts
//
// OpenAI-compatible /v1/chat/completions endpoint
// Translates OpenAI request format → ProviderRouter → OpenAI response format
// Supports both non-streaming and streaming (SSE) modes.
/**
 * Normalize OpenAI message content to internal ContentPart[] or string.
 * Passes through strings unchanged; converts OAI content arrays to internal format.
 */
function normalizeContent(content) {
    if (content === null || content === undefined)
        return "";
    if (typeof content === "string")
        return content;
    return content.map((part) => {
        if (part.type === "text")
            return { type: "text", text: part.text };
        return { type: "image_url", image_url: part.image_url };
    });
}
function makeId() {
    return `chatcmpl-${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
}
function nowSec() {
    return Math.floor(Date.now() / 1000);
}
export async function completionsRoute(fastify, opts) {
    fastify.post("/v1/chat/completions", async (request, reply) => {
        // ── Auth ────────────────────────────────────────────────────────────────
        if (opts.authToken) {
            const auth = request.headers["authorization"];
            if (!auth || auth !== `Bearer ${opts.authToken}`) {
                return reply.status(401).send({ error: { message: "Unauthorized", type: "auth_error" } });
            }
        }
        const { model, messages, stream: wantStream, tools, tool_choice } = request.body;
        if (!Array.isArray(messages) || messages.length === 0) {
            return reply.status(400).send({
                error: { message: "messages is required and must be a non-empty array", type: "invalid_request_error" },
            });
        }
        const routerMessages = messages.map((m) => ({
            role: m.role,
            content: normalizeContent(m.content),
            ...(m.tool_calls ? { tool_calls: m.tool_calls } : {}),
            ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}),
        }));
        const routerOpts = {
            ...(model ? { model } : {}),
            ...(tools && tools.length > 0 ? { tools } : {}),
            ...(tool_choice ? { tool_choice } : {}),
        };
        const chatId = makeId();
        const created = nowSec();
        // ── Streaming ────────────────────────────────────────────────────────────
        if (wantStream) {
            reply.hijack();
            const raw = reply.raw;
            raw.writeHead(200, {
                "Content-Type": "text/event-stream",
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
            });
            // Opening chunk: role delta
            const openChunk = {
                id: chatId,
                object: "chat.completion.chunk",
                created,
                model: model ?? "geminiclaw",
                choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
            };
            raw.write(`data: ${JSON.stringify(openChunk)}\n\n`);
            try {
                for await (const chunk of opts.router.stream(routerMessages, routerOpts)) {
                    if (chunk.tool_calls && chunk.tool_calls.length > 0) {
                        // emit tool_calls delta chunks (one per tool call)
                        for (let i = 0; i < chunk.tool_calls.length; i++) {
                            const tc = chunk.tool_calls[i];
                            const tcChunk = {
                                id: chatId,
                                object: "chat.completion.chunk",
                                created,
                                model: model ?? "geminiclaw",
                                choices: [{
                                        index: 0,
                                        delta: {
                                            tool_calls: [{
                                                    index: i,
                                                    id: tc.id,
                                                    type: "function",
                                                    function: { name: tc.function.name, arguments: tc.function.arguments },
                                                }],
                                        },
                                        finish_reason: null,
                                    }],
                            };
                            raw.write(`data: ${JSON.stringify(tcChunk)}\n\n`);
                        }
                        // finish_reason = tool_calls
                        const finishChunk = {
                            id: chatId,
                            object: "chat.completion.chunk",
                            created,
                            model: model ?? "geminiclaw",
                            choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
                        };
                        raw.write(`data: ${JSON.stringify(finishChunk)}\n\n`);
                        raw.write("data: [DONE]\n\n");
                    }
                    else if (chunk.delta) {
                        const dataChunk = {
                            id: chatId,
                            object: "chat.completion.chunk",
                            created,
                            model: model ?? "geminiclaw",
                            choices: [{ index: 0, delta: { content: chunk.delta }, finish_reason: null }],
                        };
                        raw.write(`data: ${JSON.stringify(dataChunk)}\n\n`);
                    }
                    if (chunk.done && !chunk.tool_calls) {
                        const doneChunk = {
                            id: chatId,
                            object: "chat.completion.chunk",
                            created,
                            model: model ?? "geminiclaw",
                            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
                        };
                        raw.write(`data: ${JSON.stringify(doneChunk)}\n\n`);
                        raw.write("data: [DONE]\n\n");
                    }
                }
            }
            catch (err) {
                const errChunk = {
                    error: { message: String(err), type: "server_error" },
                };
                raw.write(`data: ${JSON.stringify(errChunk)}\n\n`);
            }
            finally {
                raw.end();
            }
            return;
        }
        // ── Non-streaming ────────────────────────────────────────────────────────
        let response;
        try {
            response = await opts.router.chat(routerMessages, routerOpts);
        }
        catch (err) {
            return reply.status(500).send({
                error: { message: String(err), type: "server_error" },
            });
        }
        const hasToolCalls = response.tool_calls && response.tool_calls.length > 0;
        return reply.send({
            id: chatId,
            object: "chat.completion",
            created,
            model: response.model ?? model ?? "geminiclaw",
            choices: [
                {
                    index: 0,
                    message: {
                        role: "assistant",
                        content: response.content || null,
                        ...(hasToolCalls ? { tool_calls: response.tool_calls } : {}),
                    },
                    finish_reason: hasToolCalls ? "tool_calls" : (response.finish_reason ?? "stop"),
                },
            ],
            usage: {
                prompt_tokens: response.usage?.inputTokens ?? 0,
                completion_tokens: response.usage?.outputTokens ?? 0,
                total_tokens: (response.usage?.inputTokens ?? 0) + (response.usage?.outputTokens ?? 0),
            },
        });
    });
    // ── GET /v1/models — 返回可用模型列表 ────────────────────────────────────
    fastify.get("/v1/models", async (_request, reply) => {
        if (opts.authToken) {
            const auth = _request.headers["authorization"];
            if (!auth || auth !== `Bearer ${opts.authToken}`) {
                return reply.status(401).send({ error: { message: "Unauthorized", type: "auth_error" } });
            }
        }
        const models = opts.router.listModels().map((id) => ({
            id,
            object: "model",
            created: 0,
            owned_by: "geminiclaw",
        }));
        return reply.send({ object: "list", data: models });
    });
}
