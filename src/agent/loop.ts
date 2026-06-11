// @ts-nocheck
// src/agent/loop.ts
import { randomUUID } from "crypto";
import type {
  AgentEvent,
  AgentConfig,
  ToolCall,
  ToolResult,
  BeforeToolCallContext,
  AfterToolCallContext,
  PausePayload,
  GuardrailConfig,
} from "./types.js";
import type { ContentPart } from "../providers/types.js";
import { GuardrailController } from "./guardrails.js";
import { hookBus } from "../hooks/index.js";

const SEQUENTIAL_TOOLS = new Set(["exec", "write", "edit"]);
const MUTATING_TOOLS = new Set(["exec", "write", "edit", "file_write"]);

type UserOrSystemMessage = { role: "user" | "system"; content: string | ContentPart[] };
type AssistantMessage = {
  role: "assistant";
  content: string;
  tool_calls?: ToolCall[];
};
type ToolMessage = {
  role: "tool";
  tool_call_id: string;
  content: string;
  /** Multimodal content blocks for vision-capable models */
  multimodal?: ContentPart[];
};
export type InternalMessage =
  | UserOrSystemMessage
  | AssistantMessage
  | ToolMessage;

export type ChatFn = (
  messages: InternalMessage[],
  options?: { model?: string; tools?: unknown[] },
) => Promise<{ content: string; tool_calls?: ToolCall[] }>;

type JSONSchema = Record<string, unknown>;

interface ToolContext {
  sessionId: string;
  workdir: string;
  logger: {
    info(msg: string, ...args: unknown[]): void;
    warn(msg: string, ...args: unknown[]): void;
    error(msg: string, ...args: unknown[]): void;
  };
  extra?: Record<string, unknown>;
}

type ToolHandlerFn = (
  args: Record<string, unknown>,
  ctx: ToolContext,
) => Promise<ToolResult>;

export interface ToolRegistryLike {
  get(name: string): {
    handler: ToolHandlerFn;
    schema: JSONSchema;
    executionMode?: string;
  } | null;
  list(): Array<{
    name: string;
    description: string;
    schema: JSONSchema;
    executionMode?: string;
  }>;
}

interface Logger {
  debug(msg: string, ...args: unknown[]): void;
  error(msg: string, ...args: unknown[]): void;
  info?(msg: string, ...args: unknown[]): void;
  warn?(msg: string, ...args: unknown[]): void;
}

export class AgentLoop {
  private chatFn: ChatFn;
  private toolRegistry: ToolRegistryLike;
  private config: Required<
    Pick<
      AgentConfig,
      | "maxTurns"
      | "toolExecutionMode"
      | "maxToolOutputChars"
      | "systemPrompt"
    >
  > &
    Pick<
      AgentConfig,
      "maxToolCallsPerTurn" | "guardrails" | "planning" | "uncertaintyCheck"
    >;
  private logger: Logger;

  // ── Interrupt point state ──────────────────────────────────────────────────
  private pauseId: string | null = null;
  private pauseResolve: ((value: unknown) => void) | null = null;
  private uncertaintyCleared = false;
  private _toolContextExtra: Record<string, unknown> = {};

  constructor(params: {
    chatFn: ChatFn;
    toolRegistry: ToolRegistryLike;
    config?: AgentConfig;
    logger?: Logger;
  }) {
    this.chatFn = params.chatFn;
    this.toolRegistry = params.toolRegistry;
    this.config = {
      maxTurns: params.config?.maxTurns ?? 10,
      toolExecutionMode: params.config?.toolExecutionMode ?? "parallel",
      maxToolOutputChars: params.config?.maxToolOutputChars ?? 8000,
      systemPrompt: params.config?.systemPrompt ?? "",
      maxToolCallsPerTurn: params.config?.maxToolCallsPerTurn,
      guardrails: params.config?.guardrails,
      planning: params.config?.planning,
      uncertaintyCheck: params.config?.uncertaintyCheck,
    };
    this.logger = params.logger ?? {
      debug: () => undefined,
      error: () => undefined,
    };
  }

  resume(pauseId: string, userInput: unknown): boolean {
    if (this.pauseId !== pauseId || !this.pauseResolve) {
      return false;
    }
    this.pauseResolve(userInput);
    this.pauseResolve = null;
    this.pauseId = null;
    return true;
  }

  get isPaused(): boolean {
    return this.pauseResolve !== null;
  }

  get currentPauseId(): string | null {
    return this.pauseId;
  }

  // ── Main run loop ──────────────────────────────────────────────────────────
  async *run(params: {
    messages: InternalMessage[];
    sessionId: string;
    model?: string;
    signal?: AbortSignal;
    beforeToolCall?: (
      ctx: BeforeToolCallContext,
    ) => Promise<{ block?: boolean; reason?: string }>;
    afterToolCall?: (
      ctx: AfterToolCallContext,
    ) => Promise<Partial<ToolResult> | undefined>;
    toolContextExtra?: Record<string, unknown>;
  }): AsyncIterable<AgentEvent> {
    this.uncertaintyCleared = false;
    this._toolContextExtra = params.toolContextExtra ?? {};
    let messages = [...params.messages];
    let turn = 0;
    const maxTurns = this.config.maxTurns;

    // ── Command handling ────────────────────────────────────────────────────
    const lastMessage = messages[messages.length - 1];
    if (lastMessage && lastMessage.role === "user") {
      const { CommandParser } = await import("./command-parser.js");
      if (CommandParser.isCommand(lastMessage.content)) {
        const commandArgs = CommandParser.toToolCallArgs(lastMessage.content);
        if (commandArgs) {
          const toolEntry = this.toolRegistry.get("evolution_command");
          if (toolEntry) {
            try {
              const result = await toolEntry.handler(commandArgs, {
                sessionId: params.sessionId,
                workdir: process.cwd(),
                logger: {
                  info: (this.logger.info?.bind(this.logger)) ?? (() => undefined),
                  warn: (this.logger.warn?.bind(this.logger)) ?? (() => undefined),
                  error: this.logger.error.bind(this.logger),
                },
              });
              const toolRes = result as ToolResult & {
                text?: string;
                error?: string;
                content?: string;
              };
              const resultText =
                (toolRes as { type: string; text?: string }).type === "text"
                  ? (toolRes as { text?: string }).text ?? "命令执行失败"
                  : (toolRes as { type: string; error?: string }).type === "error"
                    ? `❌ ${(toolRes as { error?: string }).error}`
                    : (toolRes as { content?: string }).content ?? "命令执行失败";
              yield { type: "message_delta", delta: resultText };
              yield {
                type: "agent_end",
                totalTurns: 1,
                stopReason: "no_tool_calls",
              };
              return;
            } catch (err) {
              yield {
                type: "message_delta",
                delta: `❌ 命令执行失败: ${err}`,
              };
              yield {
                type: "agent_end",
                totalTurns: 1,
                stopReason: "aborted",
              };
              return;
            }
          }
        }
      }
    }

    const guardrails =
      this.config.guardrails
        ? new GuardrailController(this.config.guardrails)
        : null;

    let consecutiveIdleTurns = 0;
    while (turn < maxTurns) {
      if (params.signal?.aborted) {
        yield { type: "agent_end", totalTurns: turn, stopReason: "aborted" };
        return;
      }
      yield { type: "turn_start", turn };
      turn++;

      const toolSchemas = this.toolRegistry.list().map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.schema,
      }));

      // Guard: ensure system message is always present at position 0
      if (this.config.systemPrompt && messages.length > 0 && messages[0].role !== "system") {
        messages = [{ role: "system" as const, content: this.config.systemPrompt }, ...messages];
      }

      let response: { content: string; tool_calls?: ToolCall[] };
      try {
        // ── Hook: pre_llm_call ──
        await hookBus.emit("pre_llm_call", {
          messageCount: messages.length,
          model: params.model,
          sessionId: params.sessionId,
        });
        const llmStartMs = Date.now();
        response = await this.chatFn(messages, {
          model: params.model,
          tools: toolSchemas,
        });
        // ── Hook: post_llm_call ──
        await hookBus.emit("post_llm_call", {
          model: params.model,
          contentLength: response.content?.length ?? 0,
          toolCallCount: response.tool_calls?.length ?? 0,
          durationMs: Date.now() - llmStartMs,
          sessionId: params.sessionId,
        });
      } catch (err) {
        this.logger.error("chatFn threw", err);
        yield { type: "agent_end", totalTurns: turn, stopReason: "error" };
        return;
      }

      // Pi 风格：只有最终轮（无工具调用）才 emit message_delta
      if (
        response.content &&
        (!response.tool_calls || response.tool_calls.length === 0)
      ) {
        yield { type: "message_delta", delta: response.content };
      }

      // ── Plan mode: detect <plan>...</plan> and pause ──────────────────────
      if (this.config.planning?.enabled && response.content) {
        const planResult = this.extractPlan(response.content);
        if (planResult) {
          const assistantMsg: AssistantMessage = {
            role: "assistant",
            content: response.content,
          };
          messages = [...messages, assistantMsg];
          yield {
            type: "turn_end",
            message: { role: "assistant", content: response.content },
            toolCallCount: 0,
          };
          const userInput = yield* this.doPause({
            kind: "plan_ready",
            data: { plan: planResult },
          });
          const confirmMsg =
            typeof userInput === "string" && userInput.trim()
              ? userInput
              : "Plan confirmed. Please proceed with execution.";
          messages = [
            ...messages,
            { role: "user", content: confirmMsg },
          ];
          continue;
        }
      }

      const assistantMsg: AssistantMessage = {
        role: "assistant",
        content: response.content,
        tool_calls: response.tool_calls,
      };
      messages = [...messages, assistantMsg];
      yield {
        type: "turn_end",
        message: { role: "assistant", content: response.content },
        toolCallCount: response.tool_calls?.length ?? 0,
      };

      if (!response.tool_calls || response.tool_calls.length === 0) {
        // ── 空转检测：第一轮"我来…/让我…"但无工具调用 ─────────────────────
        // 模型承诺要做某事却没有行动，给一次补救机会
        if (toolSchemas.length > 0 && response.content) {
          const idlePattern = /^(好的[，,\s]|我(来|将|会|要|先|正在|立即)|让我|开始|首先|稍等|马上|接下来|现在|正在为你)/;
          const isPromise =
            idlePattern.test(response.content.trim()) &&
            response.content.length < 400;
          if (isPromise) {
            consecutiveIdleTurns++;
            if (consecutiveIdleTurns >= 2) {
              // 连续两次空转，强制终止，防止无限循环
              this.logger.error("idle-loop detected: model promised action " + consecutiveIdleTurns + " times without tool calls, aborting");
              yield { type: "message_delta", delta: "（检测到空转：模型连续承诺但不执行，已终止。）" };
              yield { type: "agent_end", totalTurns: turn, stopReason: "aborted" };
              return;
            }
            messages = [
              ...messages,
              assistantMsg,
              {
                role: "user" as const,
                content: "请直接调用工具开始执行，不要只描述计划。如果无法执行，请直接回复最终答案。",
              },
            ];
            continue; // 重跑一轮，强制执行
          }
        }
        // Reset idle counter on successful non-idle response
        consecutiveIdleTurns = 0;
        yield {
          type: "agent_end",
          totalTurns: turn,
          stopReason: "no_tool_calls",
        };
        return;
      }

      let toolCallsToRun = this.config.maxToolCallsPerTurn
        ? response.tool_calls.slice(0, this.config.maxToolCallsPerTurn)
        : response.tool_calls;

      // ── Guardrails: dedup + pre-check ────────────────────────────────────
      if (guardrails) {
        // Deduplicate identical tool calls within same turn
        const { unique, blocked } = guardrails.deduplicateToolCalls(toolCallsToRun);
        for (const [tcId, reason] of blocked) {
          const tcName = toolCallsToRun.find(tc => tc.id === tcId)?.name ?? "unknown";
          yield { type: "tool_start", toolCallId: tcId, toolName: tcName, args: {} };
          yield { type: "tool_end", toolCallId: tcId, toolName: tcName, result: { content: reason, isError: true }, isError: true, durationMs: 0 };
          messages = [...messages, { role: "tool" as const, tool_call_id: tcId, content: reason }];
        }
        toolCallsToRun = unique;

        // Pre-check: block tool calls that we already know are futile
        const preBlocked: typeof toolCallsToRun = [];
        const preAllowed: typeof toolCallsToRun = [];
        for (const tc of toolCallsToRun) {
          const decision = guardrails.beforeToolCall(tc.name, tc.args);
          if (decision.action === "block") {
            preBlocked.push(tc);
            yield { type: "tool_start", toolCallId: tc.id, toolName: tc.name, args: tc.args };
            yield { type: "tool_end", toolCallId: tc.id, toolName: tc.name, result: { content: decision.message, isError: true }, isError: true, durationMs: 0 };
            messages = [...messages, { role: "tool" as const, tool_call_id: tc.id, content: decision.message }];
          } else {
            preAllowed.push(tc);
          }
        }
        toolCallsToRun = preAllowed;

        // If all tool calls were blocked, continue to next turn (model will see block messages)
        if (toolCallsToRun.length === 0) {
          continue;
        }
      }

      // ── High-confidence mode: intercept clarify_uncertainty tool call ─────
      if (this.config.uncertaintyCheck?.enabled && !this.uncertaintyCleared) {
        const clarifyIdx = toolCallsToRun.findIndex(
          (tc) => tc.name === "clarify_uncertainty",
        );
        if (clarifyIdx !== -1) {
          const clarifyTc = toolCallsToRun[clarifyIdx];
          yield {
            type: "tool_start",
            toolCallId: clarifyTc.id,
            toolName: clarifyTc.name,
            args: clarifyTc.args,
          };
          const userAnswers = yield* this.doPause({
            kind: "uncertainty_check",
            data: { items: (clarifyTc.args as Record<string, unknown>)["items"] ?? [] },
          });
          let answersText: string;
          if (typeof userAnswers === "string" && userAnswers.trim()) {
            answersText = userAnswers;
          } else if (userAnswers && typeof userAnswers === "object") {
            const obj = userAnswers as {
              skipAll?: boolean;
              answers?: Record<string, string>;
            };
            if (obj.skipAll) {
              answersText =
                "[User chose to skip all questions — proceed with best judgment]";
            } else if (obj.answers && typeof obj.answers === "object") {
              const ans = obj.answers;
              const lines = Object.entries(ans)
                .filter(([, v]) => v && String(v).trim())
                .map(([k, v]) => `- ${k}: ${v}`);
              answersText =
                lines.length > 0
                  ? `User provided answers:\n${lines.join("\n")}`
                  : "[User confirmed: proceed with best judgment]";
            } else {
              answersText = `[User input: ${JSON.stringify(userAnswers)}]`;
            }
          } else {
            answersText = "[User confirmed: proceed with best judgment]";
          }
          yield {
            type: "tool_end",
            toolCallId: clarifyTc.id,
            toolName: clarifyTc.name,
            result: { content: answersText, isError: false },
            isError: false,
            durationMs: 0,
          };
          messages = [
            ...messages,
            {
              role: "assistant",
              content: response.content,
              tool_calls: response.tool_calls,
            },
            {
              role: "tool",
              tool_call_id: clarifyTc.id,
              content: answersText,
            },
          ];
          this.uncertaintyCleared = true;
          continue;
        }
      }

      const { events, results } = await this.executeTools(
        toolCallsToRun,
        params.sessionId,
        params.beforeToolCall,
        params.afterToolCall,
      );
      for (const event of events) {
        yield event;
      }

      // ── Guardrails: check results ─────────────────────────────────────────
      if (guardrails) {
        let anySuccess = false;
        let shouldHalt = false;
        for (const result of results) {
          const tc = toolCallsToRun.find((tc) => tc.id === result.toolCallId);
          const toolName = tc?.name ?? "unknown";

          // Check failure-based guardrail
          const decision = guardrails.record(toolName, result.isError);
          if (decision.action === "warn") {
            yield { type: "guardrail_warn", toolName, message: decision.message };
          } else if (decision.action === "halt") {
            yield { type: "guardrail_halt", toolName, message: decision.message };
            shouldHalt = true;
            break;
          }

          // [NEW] Check result-based "no-progress" guardrail for successful calls
          if (!result.isError && tc) {
            const resultDecision = guardrails.recordResult(toolName, tc.args, result.content);
            if (resultDecision.action === "warn") {
              yield { type: "guardrail_warn", toolName, message: resultDecision.message };
            } else if (resultDecision.action === "halt") {
              yield { type: "guardrail_halt", toolName, message: resultDecision.message };
              shouldHalt = true;
              break;
            }
          }

          if (!result.isError) anySuccess = true;
        }
        if (shouldHalt) {
          yield {
            type: "agent_end",
            totalTurns: turn,
            stopReason: "aborted",
          };
          return;
        }
        const anyToolCalled = results.length > 0;
        if (anyToolCalled) {
          guardrails.recordProgress();
        } else if (!anySuccess) {
          const noProgressDecision = guardrails.recordNoProgress();
          if (noProgressDecision.action === "warn") {
            yield {
              type: "guardrail_warn",
              toolName: "",
              message: noProgressDecision.message,
            };
          } else if (noProgressDecision.action === "halt") {
            yield {
              type: "guardrail_halt",
              toolName: "",
              message: noProgressDecision.message,
            };
            yield {
              type: "agent_end",
              totalTurns: turn,
              stopReason: "aborted",
            };
            return;
          }
        }
      }

      for (const tr of results) {
        messages = [
          ...messages,
          {
            role: "tool",
            tool_call_id: tr.toolCallId,
            content: tr.content,
            ...(tr.multimodal ? { multimodal: tr.multimodal } : {}),
          },
        ];
      }
    }
    // max_turns 达到上限时告知用户（防止"无回复"）
    yield {
      type: "message_delta",
      delta: `（任务已执行 ${turn} 轮，达到上限。如需继续请回复「继续」。）`,
    };
    yield { type: "agent_end", totalTurns: turn, stopReason: "max_turns" };
  }

  // ── Interrupt point implementation ────────────────────────────────────────
  private async *doPause(payload: PausePayload): AsyncIterable<AgentEvent> & AsyncGenerator<AgentEvent, unknown, unknown> {
    const pauseId = randomUUID();
    this.pauseId = pauseId;
    const waitForResume = new Promise<unknown>((resolve) => {
      this.pauseResolve = resolve;
    });
    yield { type: "paused", pauseId, payload } as AgentEvent;
    const userInput = await waitForResume;
    return userInput;
  }

  // ── Plan extraction ───────────────────────────────────────────────────────
  private extractPlan(content: string): unknown[] | null {
    const match = content.match(/<plan>([\s\S]*?)<\/plan>/);
    if (!match) return null;
    try {
      const parsed = JSON.parse(match[1].trim());
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    } catch {
      // not valid JSON, ignore
    }
    return null;
  }

  // ── Tool execution ────────────────────────────────────────────────────────
  private shouldParallelize(toolCalls: ToolCall[]): boolean {
    if (this.config.toolExecutionMode === "sequential") return false;
    return toolCalls.every((tc) => !SEQUENTIAL_TOOLS.has(tc.name));
  }

  private truncate(content: string): string {
    const max = this.config.maxToolOutputChars;
    if (content.length <= max) return content;
    return (
      content.slice(0, max) + `...[truncated ${content.length - max} chars]`
    );
  }

  private async executeSingleTool(
    tc: ToolCall,
    sessionId: string,
    beforeToolCall?: (
      ctx: BeforeToolCallContext,
    ) => Promise<{ block?: boolean; reason?: string }>,
    afterToolCall?: (
      ctx: AfterToolCallContext,
    ) => Promise<Partial<ToolResult> | undefined>,
  ): Promise<{
    events: AgentEvent[];
    result: { toolCallId: string; content: string; isError: boolean; multimodal?: ContentPart[] };
  }> {
    const events: AgentEvent[] = [];
    events.push({
      type: "tool_start",
      toolCallId: tc.id,
      toolName: tc.name,
      args: tc.args,
    });

    if (
      this.config.uncertaintyCheck?.enabled &&
      MUTATING_TOOLS.has(tc.name)
    ) {
      if (!beforeToolCall) {
        const result = {
          content: `[high-confidence mode] Cannot run "${tc.name}" before uncertainties are resolved.`,
          isError: true,
        };
        events.push({
          type: "tool_end",
          toolCallId: tc.id,
          toolName: tc.name,
          result,
          isError: true,
          durationMs: 0,
        });
        return {
          events,
          result: {
            toolCallId: tc.id,
            content: result.content,
            isError: true,
          },
        };
      }
    }

    // ── Hook: pre_tool_call (via HookBus) ──
    const hookResults = await hookBus.emitCollect("pre_tool_call", {
      toolCallId: tc.id,
      toolName: tc.name,
      args: tc.args,
      sessionId,
    });
    const hookBlock = hookResults.find(
      (r) => r && typeof r === "object" && (r as any).block,
    ) as { block: boolean; reason?: string } | undefined;
    if (hookBlock) {
      const result = {
        content: hookBlock.reason ?? `Tool ${tc.name} blocked by hook`,
        isError: true,
      };
      events.push({
        type: "tool_end",
        toolCallId: tc.id,
        toolName: tc.name,
        result,
        isError: true,
        durationMs: 0,
      });
      return {
        events,
        result: {
          toolCallId: tc.id,
          content: result.content,
          isError: true,
        },
      };
    }

    if (beforeToolCall) {
      const ctx: BeforeToolCallContext = {
        toolCallId: tc.id,
        toolName: tc.name,
        args: tc.args,
        sessionId,
      };
      const decision = await beforeToolCall(ctx);
      if (decision.block) {
        const result = {
          content: decision.reason ?? `Tool ${tc.name} was blocked`,
          isError: true,
        };
        events.push({
          type: "tool_end",
          toolCallId: tc.id,
          toolName: tc.name,
          result,
          isError: true,
          durationMs: 0,
        });
        return {
          events,
          result: {
            toolCallId: tc.id,
            content: result.content,
            isError: true,
          },
        };
      }
    }

    const entry = this.toolRegistry.get(tc.name);
    if (!entry) {
      const result = {
        content: `Tool not found: ${tc.name}`,
        isError: true,
      };
      events.push({
        type: "tool_end",
        toolCallId: tc.id,
        toolName: tc.name,
        result,
        isError: true,
        durationMs: 0,
      });
      return {
        events,
        result: { toolCallId: tc.id, content: result.content, isError: true },
      };
    }

    const startMs = Date.now();
    let toolResult: ToolResult;
    let isError = false;
    let multimodal: ContentPart[] | undefined;
    try {
      const toolContext: ToolContext = {
        sessionId,
        workdir: process.cwd(),
        logger: {
          info: (this.logger.info?.bind(this.logger)) ?? (() => undefined),
          warn: (this.logger.warn?.bind(this.logger)) ?? (() => undefined),
          error: this.logger.error.bind(this.logger),
        },
        extra: this._toolContextExtra,
      };
      const rawResult = await entry.handler(tc.args, toolContext);

      // ── Multimodal envelope handling (Hermes-style) ─────────────────────
      // Tools can return { type: "multimodal", content: [...], textSummary }
      // We extract the image parts and store them separately so they bypass truncation.
      if (rawResult && (rawResult as any).type === "multimodal") {
        const mm = rawResult as { content: Array<{ type: string; text?: string; image_url?: { url: string; detail?: string } }>; textSummary: string };
        multimodal = mm.content as ContentPart[];
        // The text content for guardrails/logging is the textSummary
        toolResult = { content: mm.textSummary, isError: false };
      } else {
        toolResult = rawResult as ToolResult;
      }
      isError = toolResult.isError ?? false;
    } catch (err) {
      isError = true;
      toolResult = {
        content: err instanceof Error ? err.message : String(err),
        isError: true,
      };
    }

    const durationMs = Date.now() - startMs;
    // Only truncate text content; multimodal image data is preserved in full
    toolResult = { ...toolResult, content: this.truncate(toolResult.content) };
    if (multimodal) {
      toolResult = { ...toolResult, multimodal };
    }

    if (afterToolCall) {
      const ctx: AfterToolCallContext = {
        toolCallId: tc.id,
        toolName: tc.name,
        args: tc.args,
        result: toolResult,
        durationMs,
        sessionId,
      };
      const override = await afterToolCall(ctx);
      if (override !== undefined) {
        toolResult = { ...toolResult, ...override };
        if (override.isError !== undefined) isError = override.isError;
      }
    }

    // ── Hook: post_tool_call (via HookBus) ──
    await hookBus.emit("post_tool_call", {
      toolCallId: tc.id,
      toolName: tc.name,
      args: tc.args,
      result: { content: toolResult.content, isError },
      durationMs,
      sessionId,
    });

    events.push({
      type: "tool_end",
      toolCallId: tc.id,
      toolName: tc.name,
      result: toolResult,
      isError,
      durationMs,
    });
    return {
      events,
      result: { toolCallId: tc.id, content: toolResult.content, isError },
    };
  }

  private async executeTools(
    toolCalls: ToolCall[],
    sessionId: string,
    beforeToolCall?: (
      ctx: BeforeToolCallContext,
    ) => Promise<{ block?: boolean; reason?: string }>,
    afterToolCall?: (
      ctx: AfterToolCallContext,
    ) => Promise<Partial<ToolResult> | undefined>,
  ): Promise<{
    events: AgentEvent[];
    results: Array<{ toolCallId: string; content: string; isError: boolean }>;
  }> {
    const allEvents: AgentEvent[] = [];
    const allResults: Array<{
      toolCallId: string;
      content: string;
      isError: boolean;
    }> = [];

    if (this.shouldParallelize(toolCalls)) {
      const outputs = await Promise.all(
        toolCalls.map((tc) =>
          this.executeSingleTool(tc, sessionId, beforeToolCall, afterToolCall),
        ),
      );
      for (const out of outputs) {
        allEvents.push(...out.events);
        allResults.push(out.result);
      }
    } else {
      for (const tc of toolCalls) {
        const out = await this.executeSingleTool(
          tc,
          sessionId,
          beforeToolCall,
          afterToolCall,
        );
        allEvents.push(...out.events);
        allResults.push(out.result);
      }
    }
    return { events: allEvents, results: allResults };
  }
}
