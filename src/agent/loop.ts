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
import { IterationBudget } from "./iteration-budget.js";
import { decideParallelization } from "./parallel-decision.js";
import { truncateToolResult, enforceTurnBudget } from "./tool-result-truncation.js";
import { EXECUTION_BIAS } from "./execution-bias.js";
import { hookBus } from "../hooks/index.js";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

// ── Tool Execution Audit Log ────────────────────────────────────────────────
const AUDIT_DIR = join(process.env.HOME ?? "/tmp", ".gemeniclaw", "audit");
try { mkdirSync(AUDIT_DIR, { recursive: true }); } catch {}

function toolAudit(event: string, data: Record<string, unknown>) {
  const ts = new Date().toISOString();
  const line = JSON.stringify({ ts, event, ...data }) + "\n";
  try {
    appendFileSync(join(AUDIT_DIR, "tool_calls.jsonl"), line, "utf-8");
  } catch {}
}

// ── Tools that are known to mutate state ────────────────────────────────────
const MUTATING_TOOLS = new Set(["exec", "write", "edit", "file_write", "execute_script"]);

// ── Tools whose execution earns a budget refund (batch tools) ───────────────
const REFUNDABLE_TOOLS = new Set(["execute_script"]);

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
  options?: { model?: string; tools?: unknown[]; thinking?: { type: 'enabled'; budget_tokens: number } },
) => Promise<{ content: string; tool_calls?: ToolCall[]; model?: string; usage?: { inputTokens: number; outputTokens: number; cacheReadInputTokens?: number; cacheCreationInputTokens?: number }; thinkingContent?: string; thinkingDurationMs?: number }>;

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
      maxTurns: params.config?.maxTurns ?? 50,
      toolExecutionMode: params.config?.toolExecutionMode ?? "parallel",
      maxToolOutputChars: params.config?.maxToolOutputChars ?? 12000,
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
    let lastModel: string | undefined;
    let lastUsage: { inputTokens: number; outputTokens: number; cacheReadInputTokens?: number; cacheCreationInputTokens?: number } | undefined;
    const maxTurns = this.config.maxTurns;

    // ── Build system prompt with Execution Bias ──────────────────────────────
    const fullSystemPrompt = this.config.systemPrompt
      ? `${this.config.systemPrompt}\n\n${EXECUTION_BIAS}`
      : "";

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

    // ── Iteration budget (replaces simple maxTurns counter) ─────────────────
    const budget = new IterationBudget(maxTurns, /* graceAllowed */ true);

    let consecutiveIdleTurns = 0;
    while (budget.remaining > 0 || budget.canGrace) {
      if (params.signal?.aborted) {
        yield { type: "agent_end", totalTurns: turn, stopReason: "aborted", model: lastModel, usage: lastUsage };
        return;
      }

      // ── Grace call: budget exhausted, produce summary without tools ────────
      if (budget.exhausted && budget.canGrace) {
        budget.useGrace();
        turn++;
        yield { type: "turn_start", turn };

        const summaryPrompt =
          "你已达到本次执行的迭代上限。请简要总结你已完成的工作、当前状态和剩余待办，不要再调用任何工具。";
        messages = [...messages, { role: "user" as const, content: summaryPrompt }];

        // Ensure system prompt is present
        if (fullSystemPrompt && messages[0]?.role !== "system") {
          messages = [{ role: "system" as const, content: fullSystemPrompt }, ...messages];
        }

        try {
          const response = await this.chatFn(messages, { model: params.model });
          lastModel = response.model;
          lastUsage = response.usage;
          if (response.content) {
            yield { type: "message_delta", delta: response.content };
          } else {
            // Grace call returned empty content — emit a fallback summary
            yield { type: "message_delta", delta: `已执行 ${turn} 轮操作，达到迭代上限。如需继续请再次发送指令。` };
          }
        } catch (err) {
          this.logger.error("Grace call failed", err);
          yield { type: "message_delta", delta: `已执行 ${turn} 轮操作，处理过程中出现异常。如需继续请再次发送指令。` };
        }

        yield { type: "agent_end", totalTurns: turn, stopReason: "max_turns", model: lastModel, usage: lastUsage };
        return;
      }

      budget.consume();
      yield { type: "turn_start", turn };
      turn++;

      const toolSchemas = this.toolRegistry.list().map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.schema,
      }));

      // DEBUG: log tool count and delegate_to presence (remove after verification)
      if (turn === 1) {
        const toolNames = toolSchemas.map((t) => t.name);
        console.log(`[AgentLoop] Turn 1: ${toolSchemas.length} tools passed to LLM. delegate_to present: ${toolNames.includes("delegate_to")}. All: ${toolNames.join(", ")}`);
      }

      // Guard: ensure system message is always present at position 0
      if (fullSystemPrompt && messages.length > 0 && messages[0].role !== "system") {
        messages = [{ role: "system" as const, content: fullSystemPrompt }, ...messages];
      }

      let response: { content: string; tool_calls?: ToolCall[]; model?: string; usage?: { inputTokens: number; outputTokens: number; cacheReadInputTokens?: number; cacheCreationInputTokens?: number }; thinkingContent?: string; thinkingDurationMs?: number };
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
          ...(this.supportsThinking(params.model) ? { thinking: { type: 'enabled', budget_tokens: 8000 } } : {}),
        });
        lastModel = response.model;
        lastUsage = response.usage;
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
        yield { type: "agent_end", totalTurns: turn, stopReason: "error", model: lastModel, usage: lastUsage };
        return;
      }

      // ── Emit thinking events if present ─────────────────────────────────────
      if (response.thinkingContent) {
        yield { type: "thinking_delta", delta: response.thinkingContent };
        yield { type: "thinking_end", content: response.thinkingContent, durationMs: response.thinkingDurationMs ?? 0 };
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
        // ── 空 content 兜底：模型返回 end_turn 但无文字，追加一次要求 ────────
        if (!response.content && budget.remaining > 0) {
          this.logger.error("empty-content final turn detected, requesting text reply");
          messages = [
            ...messages,
            {
              role: "user" as const,
              content: "你的上一条回复为空。请用文字简要回复用户，总结你已完成的工作或回答用户的问题。",
            },
          ];
          continue;
        }

        // ── 空转检测：第一轮"我来…/让我…"但无工具调用 ─────────────────────
        if (toolSchemas.length > 0 && response.content) {
          const idlePattern = /^(好的[，,\s]|我(来|将|会|要|先|正在|立即)|让我|开始|首先|稍等|马上|接下来|现在|正在为你)/;
          const isPromise =
            idlePattern.test(response.content.trim()) &&
            response.content.length < 400;
          if (isPromise) {
            consecutiveIdleTurns++;
            if (consecutiveIdleTurns >= 2) {
              this.logger.error("idle-loop detected: model promised action " + consecutiveIdleTurns + " times without tool calls, aborting");
              yield { type: "message_delta", delta: "（检测到空转：模型连续承诺但不执行，已终止。）" };
              yield { type: "agent_end", totalTurns: turn, stopReason: "aborted", model: lastModel, usage: lastUsage };
              return;
            }
            messages = [
              ...messages,
              {
                role: "user" as const,
                content: "请直接调用工具开始执行，不要只描述计划。如果无法执行，请直接回复最终答案。",
              },
            ];
            continue;
          }
        }
        consecutiveIdleTurns = 0;
        yield {
          type: "agent_end",
          totalTurns: turn,
          stopReason: "no_tool_calls",
          model: lastModel,
          usage: lastUsage,
        };
        return;
      }

      let toolCallsToRun = this.config.maxToolCallsPerTurn
        ? response.tool_calls.slice(0, this.config.maxToolCallsPerTurn)
        : response.tool_calls;

      // ── Guardrails: dedup + pre-check ────────────────────────────────────
      if (guardrails) {
        const { unique, blocked } = guardrails.deduplicateToolCalls(toolCallsToRun);
        for (const [tcId, reason] of blocked) {
          const tcName = toolCallsToRun.find(tc => tc.id === tcId)?.name ?? "unknown";
          yield { type: "tool_start", toolCallId: tcId, toolName: tcName, args: {} };
          yield { type: "tool_end", toolCallId: tcId, toolName: tcName, result: { content: reason, isError: true }, isError: true, durationMs: 0 };
          messages = [...messages, { role: "tool" as const, tool_call_id: tcId, content: reason }];
        }
        toolCallsToRun = unique;

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

      // ── Budget refund for batch tools ───────────────────────────────────────
      for (const tc of toolCallsToRun) {
        if (REFUNDABLE_TOOLS.has(tc.name)) {
          budget.refund();
        }
      }

      // ── Guardrails: check results ─────────────────────────────────────────
      if (guardrails) {
        let anySuccess = false;
        let shouldHalt = false;
        for (const result of results) {
          const tc = toolCallsToRun.find((tc) => tc.id === result.toolCallId);
          const toolName = tc?.name ?? "unknown";

          const decision = guardrails.record(toolName, result.isError);
          if (decision.action === "warn") {
            yield { type: "guardrail_warn", toolName, message: decision.message };
          } else if (decision.action === "halt") {
            yield { type: "guardrail_halt", toolName, message: decision.message };
            shouldHalt = true;
            break;
          }

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
            model: lastModel,
            usage: lastUsage,
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
              model: lastModel,
              usage: lastUsage,
            };
            return;
          }
        }
      }

      // ── Apply turn budget enforcement (Layer 3) ────────────────────────────
      const truncationResults = results.map((r) => ({
        content: r.content,
        originalLength: r.content.length,
        wasTruncated: false,
      }));
      const budgetedResults = enforceTurnBudget(truncationResults, params.sessionId);

      for (let i = 0; i < results.length; i++) {
        const tr = results[i];
        const budgeted = budgetedResults[i];
        messages = [
          ...messages,
          {
            role: "tool",
            tool_call_id: tr.toolCallId,
            content: budgeted.content,
            ...(tr.multimodal ? { multimodal: tr.multimodal } : {}),
          },
        ];
      }
    }

    // Budget fully exhausted (should not reach here due to grace handling above)
    yield {
      type: "message_delta",
      delta: `（任务已执行 ${turn} 轮，达到上限。如需继续请回复「继续」。）`,
    };
    yield { type: "agent_end", totalTurns: turn, stopReason: "max_turns", model: lastModel, usage: lastUsage };
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

  // ── Thinking support detection ────────────────────────────────────────────
  private supportsThinking(model?: string): boolean {
    const m = model ?? ''
    return m.includes('claude') && (m.includes('sonnet-4') || m.includes('opus-4') || m.includes('claude-4'))
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
    return decideParallelization(toolCalls).canParallelize;
  }

  private truncate(content: string, toolName: string, sessionId: string): string {
    const result = truncateToolResult(content, toolName, sessionId);
    return result.content;
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
    toolAudit("TOOL_EXEC_START", { toolCallId: tc.id, toolName: tc.name, argsPreview: JSON.stringify(tc.args).slice(0, 500), sessionId });
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
      const rawResult = await this.withStallGuard(
        entry.handler(tc.args, toolContext),
        tc.name,
      );

      // ── Normalize tool result format ─────────────────────────────────────
      // Tool handlers may return either:
      //   { type: "text", text: "..." }
      //   { type: "error", error: "..." }
      //   { type: "multimodal", content: [...], textSummary: "..." }
      //   { content: "...", isError?: boolean }  (internal format)
      const raw = rawResult as any;
      if (raw && raw.type === "multimodal") {
        multimodal = raw.content as ContentPart[];
        toolResult = { content: raw.textSummary ?? "", isError: false };
      } else if (raw && raw.type === "text") {
        toolResult = { content: raw.text ?? "", isError: false };
      } else if (raw && raw.type === "error") {
        toolResult = { content: raw.error ?? "Unknown error", isError: true };
      } else if (raw && typeof raw.content === "string") {
        toolResult = { content: raw.content, isError: raw.isError ?? false };
      } else {
        toolResult = { content: String(raw ?? ""), isError: false };
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
    // 2026-06-17: 扩大审计日志存储范围，防止 P5 结果丢失
    // 回滚方案：将 resultFull 改回 resultPreview: toolResult.content.slice(0, 300)
    const AUDIT_RESULT_LIMIT = 5000;
    toolAudit("TOOL_EXEC_END", {
      toolCallId: tc.id, toolName: tc.name, durationMs, isError, sessionId,
      resultPreview: toolResult.content.slice(0, 300),
      resultFull: toolResult.content.length <= AUDIT_RESULT_LIMIT
        ? toolResult.content
        : toolResult.content.slice(0, AUDIT_RESULT_LIMIT) + `\n...[truncated, total ${toolResult.content.length} chars]`,
    });
    // Smart truncation (Layer 1 + Layer 2)
    const truncationResult = truncateToolResult(toolResult.content, tc.name, sessionId);
    toolResult = { ...toolResult, content: truncationResult.content };
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

  // ── Stall guard: detect stuck tools via child process activity ─────────────
  // Unlike a simple timeout, this checks whether the Node.js process has active
  // child processes doing work. If the tool's promise hasn't resolved AND there
  // are no active children (CPU-wise) for a sustained period, it's stuck.
  //
  // Tools that are actively working (browser fetching data, script computing)
  // will keep resetting the idle counter and are allowed to run indefinitely.

  private static readonly STALL_CHECK_INTERVAL_MS = 10_000; // check every 10s
  private static readonly STALL_MAX_IDLE_CHECKS = 6;        // 6 × 10s = 60s of consecutive idleness → abort
  private static readonly STALL_MIN_RUNTIME_MS = 30_000;    // don't even start checking until 30s elapsed

  private async withStallGuard<T>(promise: Promise<T>, toolName: string): Promise<T> {
    let resolved = false;
    const startTime = Date.now();

    return new Promise<T>((resolve, reject) => {
      let consecutiveIdleChecks = 0;

      const timer = setInterval(() => {
        if (resolved) return;

        // Don't check until minimum runtime elapsed (give tool time to start)
        const elapsed = Date.now() - startTime;
        if (elapsed < AgentLoop.STALL_MIN_RUNTIME_MS) return;

        // Check if there are active child processes
        const hasActivity = this.checkChildProcessActivity();

        if (hasActivity) {
          // Something is working — reset idle counter
          consecutiveIdleChecks = 0;
        } else {
          consecutiveIdleChecks++;
          const stallSec = consecutiveIdleChecks * (AgentLoop.STALL_CHECK_INTERVAL_MS / 1000);
          this.logger.error(
            `[stall-guard] Tool "${toolName}" idle check ${consecutiveIdleChecks}/${AgentLoop.STALL_MAX_IDLE_CHECKS} (${stallSec}s idle, ${Math.round(elapsed / 1000)}s total)`
          );

          if (consecutiveIdleChecks >= AgentLoop.STALL_MAX_IDLE_CHECKS) {
            resolved = true;
            clearInterval(timer);
            reject(new Error(
              `[stall-guard] Tool "${toolName}" appears stuck: no child process activity ` +
              `for ${stallSec}s (total runtime: ${Math.round(elapsed / 1000)}s). Aborting.`
            ));
          }
        }
      }, AgentLoop.STALL_CHECK_INTERVAL_MS);

      promise.then(
        (val) => { resolved = true; clearInterval(timer); resolve(val); },
        (err) => { resolved = true; clearInterval(timer); reject(err); },
      );
    });
  }

  /**
   * Check if the current process has any child processes with meaningful CPU activity.
   * Returns true if at least one child is consuming > 1% CPU, or if we can't determine
   * (fail-open: don't kill what we can't measure).
   */
  private checkChildProcessActivity(): boolean {
    try {
      const { execSync } = require("child_process");
      const pid = process.pid;
      // Get all child process CPU usage
      const output = execSync(
        `pgrep -P ${pid} | xargs -I{} ps -p {} -o %cpu= 2>/dev/null`,
        { timeout: 3000, encoding: "utf-8" },
      ).trim();

      if (!output) {
        // No child processes at all — tool is running in-process (e.g. pure async/await)
        // Can't determine activity from child processes, so check if there are open
        // network sockets that might indicate active work
        return this.checkNetworkActivity(pid);
      }

      // Check if any child has CPU > 1%
      const cpuValues = output.split("\n").map((l) => parseFloat(l.trim())).filter((v) => !isNaN(v));
      return cpuValues.some((cpu) => cpu > 1.0);
    } catch {
      // Can't determine — fail open (assume active, don't kill)
      return true;
    }
  }

  /**
   * Check if the process has network connections beyond the baseline
   * (WebSocket to QQ, listening port). If there are extra TCP connections
   * in ESTABLISHED state, something is actively fetching.
   */
  private checkNetworkActivity(pid: number): boolean {
    try {
      const { execSync } = require("child_process");
      // Count ESTABLISHED TCP connections (excluding our known ones: listen port + QQ WebSocket)
      const output = execSync(
        `lsof -p ${pid} -i TCP -sTCP:ESTABLISHED 2>/dev/null | grep -v "LISTEN" | wc -l`,
        { timeout: 3000, encoding: "utf-8" },
      ).trim();
      const count = parseInt(output, 10) || 0;
      // Baseline: 1 connection (QQ WebSocket). If more, something is active.
      return count > 2;
    } catch {
      return true; // fail open
    }
  }
}
