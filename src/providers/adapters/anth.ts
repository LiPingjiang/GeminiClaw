// @ts-nocheck
// src/providers/adapters/anth.ts
// Protocol adapter for the Anthropic Messages API (anth-messages).
// Pure functions — no class, no state.
import Anthropic from "@anthropic-ai/sdk";
// ── Anthropic client factory ──────────────────────────────────────────────────
function createClient(config) {
    return new Anthropic({
        apiKey: config.apiKey ?? "dummy",
        ...(config.baseUrl ? { baseURL: config.baseUrl } : {}),
        ...(config.headers ? { defaultHeaders: config.headers } : {}),
        timeout: 120_000,   // 2 minutes (prevent 10min+ hangs)
        maxRetries: 1,      // 1 retry only
    });
}
/**
 * Whether this endpoint supports tool_choice parameter.
 * Official Anthropic API does; local proxies generally do not.
 */
function checkToolChoice(config) {
    const baseUrl = config.baseUrl ?? "";
    return !baseUrl || baseUrl.includes("api.anthropic.com");
}
// ── Tool format converters ────────────────────────────────────────────────────
function toAnthropicToolChoice(tc) {
    if (!tc)
        return undefined;
    if (tc === "auto")
        return { type: "auto" };
    if (tc === "none")
        return { type: "none" };
    if (tc === "required")
        return { type: "any" };
    if (typeof tc === "object" && tc.type === "function") {
        return { type: "tool", name: tc.function.name };
    }
    return undefined;
}
function toAnthropicTool(tool) {
    return {
        name: tool.function.name,
        description: tool.function.description ?? "",
        input_schema: (tool.function.parameters ?? {
            type: "object",
            properties: {},
        }),
    };
}
function fromAnthropicToolUse(blocks) {
    return blocks.map(b => ({
        id: b.id,
        type: "function",
        function: {
            name: b.name,
            arguments: JSON.stringify(b.input),
        },
    }));
}
function toAnthropicMessages(messages) {
    const result = [];
    for (const m of messages) {
        if (m.role === "system")
            continue;
        if (m.role === "tool") {
            const last = result[result.length - 1];
            // Build tool_result content — include multimodal images if present
            let toolContent;
            if (m.multimodal && Array.isArray(m.multimodal) && m.multimodal.length > 0) {
                // Convert ContentPart[] to Anthropic content blocks inside tool_result
                toolContent = m.multimodal.map((part) => {
                    if (part.type === "text") {
                        return { type: "text", text: part.text };
                    }
                    const url = part.image_url.url;
                    if (url.startsWith("data:")) {
                        const [meta, data] = url.split(",", 2);
                        const mediaType = (meta.split(";")[0].split(":")[1] ?? "image/jpeg");
                        return { type: "image", source: { type: "base64", media_type: mediaType, data } };
                    }
                    return { type: "image", source: { type: "url", url } };
                });
            } else {
                toolContent = typeof m.content === "string" ? m.content : "";
            }
            const block = {
                type: "tool_result",
                tool_use_id: m.tool_call_id ?? "",
                content: toolContent,
            };
            if (last && last.role === "user" && Array.isArray(last.content)) {
                ;
                last.content.push(block);
            }
            else {
                result.push({ role: "user", content: [block] });
            }
            continue;
        }
        if (m.role === "assistant" && m.tool_calls && m.tool_calls.length > 0) {
            const content = [];
            if (m.content && (typeof m.content === "string" ? m.content : "").trim()) {
                content.push({
                    type: "text",
                    text: typeof m.content === "string" ? m.content : "",
                });
            }
            for (const tc of m.tool_calls) {
                let input = {};
                try {
                    input = JSON.parse(tc.function.arguments);
                }
                catch {
                    /* ignore */
                }
                content.push({ type: "tool_use", id: tc.id, name: tc.function.name, input });
            }
            result.push({ role: "assistant", content });
            continue;
        }
        result.push({
            role: m.role,
            content: toAnthropicContent(m.content),
        });
    }
    return result;
}
function toAnthropicContent(content) {
    if (typeof content === "string")
        return content;
    return content.map((part) => {
        if (part.type === "text") {
            return { type: "text", text: part.text };
        }
        const url = part.image_url.url;
        if (url.startsWith("data:")) {
            const [meta, data] = url.split(",", 2);
            const mediaType = (meta.split(";")[0].split(":")[1] ?? "image/jpeg");
            return { type: "image", source: { type: "base64", media_type: mediaType, data } };
        }
        return { type: "image", source: { type: "url", url } };
    });
}
function buildSystemString(messages) {
    return messages
        .filter(m => m.role === "system")
        .map(m => typeof m.content === "string"
        ? m.content
        : m.content.map(p => (p.type === "text" ? p.text : "")).join(""))
        .join("\n");
}
// ── Public adapter functions ──────────────────────────────────────────────────
export async function anthMessagesChat(config, messages, options) {
    const client = createClient(config);
    const supportsToolChoice = checkToolChoice(config);
    const model = options?.model ?? config.models[0];
    const systemStr = buildSystemString(messages);
    const anthropicMessages = toAnthropicMessages(messages);
    const tools = options?.tools?.map(toAnthropicTool);
    const toolChoice = supportsToolChoice
        ? toAnthropicToolChoice(options?.tool_choice)
        : undefined;
    const response = await client.messages.create({
        model,
        max_tokens: options?.maxTokens ?? 4096,
        ...(options?.temperature !== undefined ? { temperature: options.temperature } : {}),
        ...(systemStr ? { system: systemStr } : {}),
        ...(tools && tools.length > 0 ? { tools } : {}),
        ...(toolChoice ? { tool_choice: toolChoice } : {}),
        messages: anthropicMessages,
    });
    if (response.stop_reason === "error") {
        const errText = response.content.find(b => b.type === "text");
        throw new Error(`Provider returned stop_reason=error: ${errText?.type === "text" ? errText.text : "unknown error"}`);
    }
    const textBlock = response.content.find(b => b.type === "text");
    const content = textBlock && textBlock.type === "text" ? textBlock.text : "";
    const toolUseBlocks = response.content.filter((b) => b.type === "tool_use");
    const tool_calls = toolUseBlocks.length > 0 ? fromAnthropicToolUse(toolUseBlocks) : undefined;
    return {
        content,
        model: response.model,
        finish_reason: response.stop_reason ?? undefined,
        tool_calls,
        usage: {
            inputTokens: response.usage.input_tokens,
            outputTokens: response.usage.output_tokens,
        },
    };
}
export async function* anthMessagesStream(config, messages, options) {
    const client = createClient(config);
    const supportsToolChoice = checkToolChoice(config);
    const model = options?.model ?? config.models[0];
    const systemStr = buildSystemString(messages);
    const anthropicMessages = toAnthropicMessages(messages);
    const tools = options?.tools?.map(toAnthropicTool);
    const toolChoice = supportsToolChoice
        ? toAnthropicToolChoice(options?.tool_choice)
        : undefined;
    const toolInputBuffers = new Map();
    const stream = client.messages.stream({
        model,
        max_tokens: options?.maxTokens ?? 4096,
        ...(options?.temperature !== undefined ? { temperature: options.temperature } : {}),
        ...(systemStr ? { system: systemStr } : {}),
        ...(tools && tools.length > 0 ? { tools } : {}),
        ...(toolChoice ? { tool_choice: toolChoice } : {}),
        messages: anthropicMessages,
    });
    for await (const event of stream) {
        if (event.type === "content_block_start" &&
            event.content_block.type === "tool_use") {
            toolInputBuffers.set(event.index, {
                id: event.content_block.id,
                name: event.content_block.name,
                json: "",
            });
        }
        else if (event.type === "content_block_delta") {
            if (event.delta.type === "text_delta") {
                yield { delta: event.delta.text, done: false };
            }
            else if (event.delta.type === "input_json_delta") {
                const buf = toolInputBuffers.get(event.index);
                if (buf)
                    buf.json += event.delta.partial_json;
            }
        }
        else if (event.type === "message_stop") {
            if (toolInputBuffers.size > 0) {
                const tool_calls = Array.from(toolInputBuffers.values()).map(buf => ({
                    id: buf.id,
                    type: "function",
                    function: { name: buf.name, arguments: buf.json },
                }));
                yield { delta: "", done: false, tool_calls };
            }
        }
    }
    yield { delta: "", done: true };
}
