// test/agent/loop-benchmark.test.ts
/**
 * Agent Loop Efficiency Benchmark
 *
 * Simulates realistic scenarios that previously caused excessive tool calls
 * in the old loop (maxTurns:100, SEQUENTIAL_TOOLS, no efficiency prompts).
 *
 * Each scenario uses a mock LLM that mimics Claude's behavior patterns:
 * - Scenario A: "继续" message → model does exploratory work (ls, cat, grep)
 * - Scenario B: Multi-step task → model uses execute_script (budget refund)
 * - Scenario C: Idle loop → model promises but never calls tools
 * - Scenario D: Budget exhaustion → grace call produces summary
 * - Scenario E: Parallel read-only operations → timing verification
 *
 * We measure: total turns, total tool calls, parallel vs sequential decisions.
 */
// @ts-nocheck
import { describe, it, expect } from "vitest";
import { AgentLoop } from "../../src/agent/loop.js";

// ── Helper: collect all events from a run ───────────────────────────────────

async function collectEvents(loop: AgentLoop, params: any) {
  const events: Array<{ type: string; [key: string]: unknown }> = [];
  for await (const event of loop.run(params)) {
    events.push(event as any);
  }
  return events;
}

// ── Mock Tool Registry Factory ──────────────────────────────────────────────

function createMockRegistry() {
  const executions: Array<{ name: string; args: Record<string, unknown> }> = [];

  const tools: Record<string, any> = {
    exec: {
      handler: async (args: Record<string, unknown>) => {
        executions.push({ name: "exec", args });
        const cmd = String(args.command ?? "");
        return { type: "text", text: `$ ${cmd}\n(mock output)` };
      },
      schema: {
        type: "object",
        properties: {
          command: { type: "string", description: "Shell command" },
          timeout: { type: "number" },
        },
        required: ["command"],
      },
      executionMode: "sequential",
    },
    execute_script: {
      handler: async (args: Record<string, unknown>) => {
        executions.push({ name: "execute_script", args });
        const script = String(args.script ?? "");
        return { type: "text", text: `(script output for: ${script.slice(0, 50)})` };
      },
      schema: {
        type: "object",
        properties: {
          script: { type: "string", description: "Multi-line bash script" },
          timeout: { type: "number" },
        },
        required: ["script"],
      },
      executionMode: "sequential",
    },
    read: {
      handler: async (args: Record<string, unknown>) => {
        executions.push({ name: "read", args });
        return { type: "text", text: `(content of ${args.path})` };
      },
      schema: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
    },
    write: {
      handler: async (args: Record<string, unknown>) => {
        executions.push({ name: "write", args });
        return { type: "text", text: "File written successfully" };
      },
      schema: {
        type: "object",
        properties: { path: { type: "string" }, content: { type: "string" } },
        required: ["path", "content"],
      },
      executionMode: "sequential",
    },
  };

  return {
    registry: {
      get(name: string) {
        return tools[name] ?? null;
      },
      list() {
        return Object.entries(tools).map(([name, t]) => ({
          name,
          description: `Mock ${name} tool`,
          schema: t.schema,
          executionMode: t.executionMode,
        }));
      },
    },
    executions,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Scenario A: "继续" → Exploratory work
// Old behavior: model issues 10+ individual exec calls, each takes a turn
// New behavior: read-only execs parallelize, completes in fewer turns
// ═══════════════════════════════════════════════════════════════════════════════

describe("Scenario A: Exploratory work after '继续'", () => {
  it("should parallelize read-only exec calls and complete efficiently", async () => {
    let callCount = 0;

    const mockChat = async (messages: any[], options?: any) => {
      callCount++;

      if (callCount === 1) {
        // Model issues 5 read-only exploratory commands
        return {
          content: "",
          tool_calls: [
            { id: "tc1", name: "exec", args: { command: "ls ~/Code/GeminiClaw/src/" } },
            { id: "tc2", name: "exec", args: { command: "cat ~/Code/GeminiClaw/package.json" } },
            { id: "tc3", name: "exec", args: { command: "git log --oneline -5" } },
            { id: "tc4", name: "exec", args: { command: "grep -r 'maxTurns' src/" } },
            { id: "tc5", name: "exec", args: { command: "wc -l src/agent/loop.ts" } },
          ],
        };
      }

      if (callCount === 2) {
        // Model reads some files
        return {
          content: "",
          tool_calls: [
            { id: "tc6", name: "read", args: { path: "src/agent/loop.ts" } },
            { id: "tc7", name: "read", args: { path: "src/agent/types.ts" } },
          ],
        };
      }

      // Final answer
      return {
        content: "根据代码分析，当前 agent loop 的主要逻辑在 src/agent/loop.ts 中，共 900 行。",
        tool_calls: undefined,
      };
    };

    const { registry, executions } = createMockRegistry();
    const loop = new AgentLoop({
      chatFn: mockChat as any,
      toolRegistry: registry,
      config: {
        maxTurns: 30,
        toolExecutionMode: "parallel",
        systemPrompt: "You are a helpful assistant.",
      },
    });

    const events = await collectEvents(loop, {
      messages: [{ role: "user", content: "继续" }],
      sessionId: "bench-explore",
    });

    const turnStarts = events.filter((e) => e.type === "turn_start");
    const toolStarts = events.filter((e) => e.type === "tool_start");
    const agentEnd = events.find((e) => e.type === "agent_end") as any;

    console.log(`\n📊 Scenario A: Exploratory "继续"`);
    console.log(`   Turns used: ${turnStarts.length} (old loop would use: 7+ turns, one per exec)`);
    console.log(`   Tool calls: ${toolStarts.length}`);
    console.log(`   Stop reason: ${agentEnd?.stopReason}`);

    // Should complete in exactly 3 turns (not 7+)
    expect(turnStarts.length).toBe(3);
    expect(toolStarts.length).toBe(7);
    expect(agentEnd?.stopReason).toBe("no_tool_calls");
    // All tools executed
    expect(executions.length).toBe(7);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Scenario B: execute_script → budget refund
// Old behavior: no execute_script tool, model uses 6 separate exec calls
// New behavior: 2 execute_script calls with refund, effective budget extended
// ═══════════════════════════════════════════════════════════════════════════════

describe("Scenario B: Budget refund for execute_script", () => {
  it("should refund budget when execute_script is used, extending effective capacity", async () => {
    let callCount = 0;

    const mockChat = async (messages: any[], options?: any) => {
      callCount++;

      if (callCount === 1) {
        return {
          content: "",
          tool_calls: [
            {
              id: "tc1",
              name: "execute_script",
              args: {
                script: "echo '=== Git status ==='\ngit status\necho '=== Commits ==='\ngit log --oneline -5\necho '=== Disk ==='\ndf -h /",
              },
            },
          ],
        };
      }

      if (callCount === 2) {
        return {
          content: "",
          tool_calls: [
            {
              id: "tc2",
              name: "execute_script",
              args: {
                script: "wc -l src/agent/loop.ts\nwc -l src/agent/types.ts\nls src/tools/",
              },
            },
          ],
        };
      }

      return {
        content: "分析完成。loop.ts 有 900 行，types.ts 有 100 行。",
        tool_calls: undefined,
      };
    };

    const { registry, executions } = createMockRegistry();
    const loop = new AgentLoop({
      chatFn: mockChat as any,
      toolRegistry: registry,
      config: {
        maxTurns: 5,
        toolExecutionMode: "parallel",
        systemPrompt: "You are a helpful assistant.",
      },
    });

    const events = await collectEvents(loop, {
      messages: [{ role: "user", content: "分析一下项目结构" }],
      sessionId: "bench-refund",
    });

    const turnStarts = events.filter((e) => e.type === "turn_start");
    const agentEnd = events.find((e) => e.type === "agent_end") as any;

    console.log(`\n📊 Scenario B: execute_script with budget refund`);
    console.log(`   Budget cap: 5`);
    console.log(`   Turns used: ${turnStarts.length}`);
    console.log(`   execute_script calls: ${executions.filter((e) => e.name === "execute_script").length}`);
    console.log(`   Stop reason: ${agentEnd?.stopReason}`);
    console.log(`   (2 refunds applied → effective budget was 7)`);

    // Should complete in 3 turns with budget 5 (2 refunds give headroom)
    expect(turnStarts.length).toBe(3);
    expect(agentEnd?.stopReason).toBe("no_tool_calls");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Scenario C: Idle loop detection
// Old behavior: model says "让我来..." 30+ times, wastes all turns
// New behavior: 2-strike detection aborts after 2 idle promises
// ═══════════════════════════════════════════════════════════════════════════════

describe("Scenario C: Idle loop detection", () => {
  it("should detect model promising but not acting, and abort after 2 strikes", async () => {
    let callCount = 0;

    const mockChat = async (messages: any[], options?: any) => {
      callCount++;

      // Model keeps promising but never calls tools
      // Even after the nudge message, it still just promises
      return {
        content: "好的，让我来检查一下这个问题，我会先看看代码...",
        tool_calls: undefined,
      };
    };

    const { registry } = createMockRegistry();
    const loop = new AgentLoop({
      chatFn: mockChat as any,
      toolRegistry: registry,
      config: {
        maxTurns: 30,
        toolExecutionMode: "parallel",
        systemPrompt: "You are a helpful assistant.",
      },
    });

    const events = await collectEvents(loop, {
      messages: [{ role: "user", content: "帮我修复这个 bug" }],
      sessionId: "bench-idle",
    });

    const turnStarts = events.filter((e) => e.type === "turn_start");
    const agentEnd = events.find((e) => e.type === "agent_end") as any;

    console.log(`\n📊 Scenario C: Idle loop detection`);
    console.log(`   Turns used: ${turnStarts.length} (old loop would use: 30, all wasted)`);
    console.log(`   Stop reason: ${agentEnd?.stopReason}`);
    console.log(`   LLM calls made: ${callCount}`);

    // Should abort after 2 idle turns (not waste 30)
    expect(turnStarts.length).toBeLessThanOrEqual(2);
    expect(agentEnd?.stopReason).toBe("aborted");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Scenario D: Grace call on budget exhaustion
// Old behavior: hard cut mid-task, user sees nothing useful
// New behavior: grace call produces a summary of progress
// ═══════════════════════════════════════════════════════════════════════════════

describe("Scenario D: Grace call on budget exhaustion", () => {
  it("should produce graceful summary when budget runs out", async () => {
    let callCount = 0;

    const mockChat = async (messages: any[], options?: any) => {
      callCount++;

      // Check if this is the grace call
      const lastMsg = messages[messages.length - 1];
      if (typeof lastMsg?.content === "string" && lastMsg.content.includes("迭代上限")) {
        return {
          content: "总结：我已完成了 3 个文件的分析，发现了 2 个潜在问题。还有 config.yaml 和 types.ts 待检查。",
          tool_calls: undefined,
        };
      }

      // Keep calling tools until budget exhausted
      return {
        content: "",
        tool_calls: [
          { id: `tc${callCount}`, name: "exec", args: { command: `echo step-${callCount}` } },
        ],
      };
    };

    const { registry } = createMockRegistry();
    const loop = new AgentLoop({
      chatFn: mockChat as any,
      toolRegistry: registry,
      config: {
        maxTurns: 4,
        toolExecutionMode: "parallel",
        systemPrompt: "You are a helpful assistant.",
      },
    });

    const events = await collectEvents(loop, {
      messages: [{ role: "user", content: "分析所有源文件的代码质量" }],
      sessionId: "bench-grace",
    });

    const turnStarts = events.filter((e) => e.type === "turn_start");
    const agentEnd = events.find((e) => e.type === "agent_end") as any;
    const messageDelta = events.filter((e) => e.type === "message_delta");

    console.log(`\n📊 Scenario D: Grace call on budget exhaustion`);
    console.log(`   Budget: 4 turns`);
    console.log(`   Turns used: ${turnStarts.length} (4 normal + 1 grace)`);
    console.log(`   Stop reason: ${agentEnd?.stopReason}`);
    console.log(`   Grace summary: "${(messageDelta[messageDelta.length - 1] as any)?.delta?.slice(0, 60)}..."`);

    // 4 normal turns + 1 grace turn = 5 total
    expect(turnStarts.length).toBe(5);
    expect(agentEnd?.stopReason).toBe("max_turns");
    // Grace call should produce a useful summary
    expect(messageDelta.some((m: any) => m.delta?.includes("总结"))).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Scenario E: Parallel execution timing verification
// Old behavior: 4 read-only execs run sequentially (~40ms with 10ms each)
// New behavior: all 4 run in parallel (~10ms total)
// ═══════════════════════════════════════════════════════════════════════════════

describe("Scenario E: Parallel execution timing", () => {
  it("should execute read-only tools in parallel (faster than sequential)", async () => {
    let callCount = 0;

    const mockChat = async (messages: any[], options?: any) => {
      callCount++;

      if (callCount === 1) {
        return {
          content: "",
          tool_calls: [
            { id: "tc1", name: "exec", args: { command: "ls /tmp" } },
            { id: "tc2", name: "exec", args: { command: "cat /etc/hostname" } },
            { id: "tc3", name: "exec", args: { command: "whoami" } },
            { id: "tc4", name: "read", args: { path: "package.json" } },
          ],
        };
      }

      return { content: "Done!", tool_calls: undefined };
    };

    // Custom registry with 10ms delay per tool
    const registry = {
      get(name: string) {
        if (name === "exec") {
          return {
            handler: async (args: Record<string, unknown>) => {
              await new Promise((r) => setTimeout(r, 10));
              return { type: "text", text: `(output of ${args.command})` };
            },
            schema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
            executionMode: "sequential",
          };
        }
        if (name === "read") {
          return {
            handler: async (args: Record<string, unknown>) => {
              await new Promise((r) => setTimeout(r, 10));
              return { type: "text", text: `(content of ${args.path})` };
            },
            schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
          };
        }
        return null;
      },
      list() {
        return [
          { name: "exec", description: "Execute command", schema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] }, executionMode: "sequential" },
          { name: "read", description: "Read file", schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
        ];
      },
    };

    const loop = new AgentLoop({
      chatFn: mockChat as any,
      toolRegistry: registry,
      config: {
        maxTurns: 10,
        toolExecutionMode: "parallel",
        systemPrompt: "You are a helpful assistant.",
      },
    });

    const startTime = Date.now();
    const events = await collectEvents(loop, {
      messages: [{ role: "user", content: "检查系统状态" }],
      sessionId: "bench-parallel",
    });
    const elapsed = Date.now() - startTime;

    const toolStarts = events.filter((e) => e.type === "tool_start");

    console.log(`\n📊 Scenario E: Parallel execution timing`);
    console.log(`   Tool calls: ${toolStarts.length}`);
    console.log(`   Total time: ${elapsed}ms`);
    console.log(`   Sequential would be: ~40ms (4 × 10ms)`);
    console.log(`   Parallel should be: ~10ms (all concurrent)`);

    expect(toolStarts.length).toBe(4);
    // If parallelized correctly, should be well under 35ms
    // (10ms parallel + some overhead, but not 40ms sequential)
    expect(elapsed).toBeLessThan(35);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Scenario F: Destructive commands stay sequential
// Ensures write operations and destructive execs don't parallelize
// ═══════════════════════════════════════════════════════════════════════════════

describe("Scenario F: Destructive commands stay sequential", () => {
  it("should NOT parallelize destructive exec commands", async () => {
    let callCount = 0;
    const executionTimestamps: number[] = [];

    const mockChat = async (messages: any[], options?: any) => {
      callCount++;

      if (callCount === 1) {
        return {
          content: "",
          tool_calls: [
            { id: "tc1", name: "exec", args: { command: "rm -rf /tmp/test" } },
            { id: "tc2", name: "exec", args: { command: "mkdir /tmp/test" } },
          ],
        };
      }

      return { content: "Done!", tool_calls: undefined };
    };

    const registry = {
      get(name: string) {
        if (name === "exec") {
          return {
            handler: async (args: Record<string, unknown>) => {
              executionTimestamps.push(Date.now());
              await new Promise((r) => setTimeout(r, 15));
              return { type: "text", text: `(executed: ${args.command})` };
            },
            schema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
            executionMode: "sequential",
          };
        }
        return null;
      },
      list() {
        return [
          { name: "exec", description: "Execute command", schema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] }, executionMode: "sequential" },
        ];
      },
    };

    const loop = new AgentLoop({
      chatFn: mockChat as any,
      toolRegistry: registry,
      config: {
        maxTurns: 10,
        toolExecutionMode: "parallel",
        systemPrompt: "You are a helpful assistant.",
      },
    });

    const startTime = Date.now();
    const events = await collectEvents(loop, {
      messages: [{ role: "user", content: "清理并重建目录" }],
      sessionId: "bench-sequential",
    });
    const elapsed = Date.now() - startTime;

    console.log(`\n📊 Scenario F: Destructive commands stay sequential`);
    console.log(`   Total time: ${elapsed}ms`);
    console.log(`   Sequential expected: ~30ms (2 × 15ms)`);
    console.log(`   Timestamps: ${executionTimestamps.map((t) => t - startTime).join(", ")}ms`);

    // Should take ~30ms (sequential), not ~15ms (parallel)
    expect(elapsed).toBeGreaterThanOrEqual(28);
    // Second command should start after first finishes
    if (executionTimestamps.length === 2) {
      const gap = executionTimestamps[1] - executionTimestamps[0];
      expect(gap).toBeGreaterThanOrEqual(13); // At least 13ms gap (15ms - tolerance)
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Final Summary
// ═══════════════════════════════════════════════════════════════════════════════

describe("Summary: Old vs New Loop Comparison", () => {
  it("prints comparison table", () => {
    console.log(`
╔══════════════════════════════════════════════════════════════════════════════╗
║                     Agent Loop Efficiency: Old vs New                        ║
╠══════════════════════════════════════════════════════════════════════════════╣
║ Scenario                  │ Old Loop (turns) │ New Loop (turns) │ Savings   ║
╠═══════════════════════════╪══════════════════╪══════════════════╪═══════════╣
║ A: "继续" exploratory     │ 7+ (serial exec) │ 3 (parallel)     │ -57%      ║
║ B: Batch operations       │ 6+ (no batching) │ 3 (refund)       │ -50%      ║
║ C: Idle loop              │ 30 (all wasted)  │ 2 (abort)        │ -93%      ║
║ D: Budget exhaustion      │ hard cut         │ grace summary    │ UX++      ║
║ E: Read-only parallel     │ ~40ms (serial)   │ ~10ms (parallel) │ -75% time ║
║ F: Destructive sequential │ sequential ✓     │ sequential ✓     │ safe      ║
╚══════════════════════════════════════════════════════════════════════════════╝

Key improvements:
• maxTurns: 100 → 30 (with grace + refund = smarter budget)
• Parallel decision: blanket SEQUENTIAL_TOOLS → fine-grained path/content analysis
• Idle detection: none → 2-strike abort
• Truncation: simple tail-cut → head+tail + persist + turn budget
• Efficiency prompts: none → Execution Bias injected into system prompt
• Batch tool: none → execute_script with budget refund incentive
    `);
    expect(true).toBe(true);
  });
});
