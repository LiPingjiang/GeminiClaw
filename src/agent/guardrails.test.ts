// src/agent/guardrails.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { GuardrailController } from "./guardrails.js";

describe("GuardrailController", () => {
  let guard: GuardrailController;

  beforeEach(() => {
    guard = new GuardrailController();
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Existing behavior: failure tracking
  // ══════════════════════════════════════════════════════════════════════════

  describe("record() — failure tracking", () => {
    it("continues on first few failures", () => {
      expect(guard.record("exec", true).action).toBe("continue");
      expect(guard.record("exec", true).action).toBe("continue");
    });

    it("warns after sameToolFailureWarnAfter (default 3)", () => {
      guard.record("exec", true);
      guard.record("exec", true);
      const decision = guard.record("exec", true);
      expect(decision.action).toBe("warn");
    });

    it("halts after sameToolFailureHaltAfter (default 8)", () => {
      for (let i = 0; i < 7; i++) guard.record("exec", true);
      const decision = guard.record("exec", true);
      expect(decision.action).toBe("halt");
    });

    it("resets on success", () => {
      guard.record("exec", true);
      guard.record("exec", true);
      guard.record("exec", false); // success resets
      expect(guard.record("exec", true).action).toBe("continue");
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // NEW: Idempotent no-progress detection
  // ══════════════════════════════════════════════════════════════════════════

  describe("recordResult() — idempotent no-progress", () => {
    it("continues on first call", () => {
      const decision = guard.recordResult("web_search", { query: "test" }, "result A");
      expect(decision.action).toBe("continue");
    });

    it("warns after same result repeated (default: 2)", () => {
      guard.recordResult("web_search", { query: "test" }, "same result");
      const decision = guard.recordResult("web_search", { query: "test" }, "same result");
      expect(decision.action).toBe("warn");
      expect(decision).toHaveProperty("message");
    });

    it("does NOT warn if result is different", () => {
      guard.recordResult("web_search", { query: "test" }, "result A");
      const decision = guard.recordResult("web_search", { query: "test" }, "result B");
      expect(decision.action).toBe("continue");
    });

    it("does NOT warn if args are different", () => {
      guard.recordResult("web_search", { query: "test1" }, "same content");
      const decision = guard.recordResult("web_search", { query: "test2" }, "same content");
      expect(decision.action).toBe("continue");
    });

    it("halts after repeated results reach halt threshold (default: 5)", () => {
      const args = { query: "infinite loop" };
      const content = "百度百科 garbage result";
      for (let i = 0; i < 4; i++) {
        guard.recordResult("web_search", args, content);
      }
      const decision = guard.recordResult("web_search", args, content);
      expect(decision.action).toBe("halt");
    });

    it("ignores non-idempotent tools", () => {
      guard.recordResult("exec", { cmd: "ls" }, "output");
      const decision = guard.recordResult("exec", { cmd: "ls" }, "output");
      expect(decision.action).toBe("continue");
    });

    it("warns only once then continues until halt", () => {
      const args = { query: "q" };
      guard.recordResult("web_search", args, "same");
      expect(guard.recordResult("web_search", args, "same").action).toBe("warn");
      expect(guard.recordResult("web_search", args, "same").action).toBe("continue"); // warn already emitted
      expect(guard.recordResult("web_search", args, "same").action).toBe("continue");
      expect(guard.recordResult("web_search", args, "same").action).toBe("halt");
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // NEW: beforeToolCall — pre-execution blocking
  // ══════════════════════════════════════════════════════════════════════════

  describe("beforeToolCall() — pre-execution blocking", () => {
    it("allows first call", () => {
      expect(guard.beforeToolCall("web_search", { query: "test" }).action).toBe("continue");
    });

    it("blocks after halt threshold reached", () => {
      const args = { query: "loop" };
      // Simulate reaching the halt threshold via recordResult
      for (let i = 0; i < 5; i++) {
        guard.recordResult("web_search", args, "same garbage");
      }
      // Now the next call should be blocked before execution
      const decision = guard.beforeToolCall("web_search", args);
      expect(decision.action).toBe("block");
    });

    it("does NOT block non-idempotent tools", () => {
      const args = { cmd: "echo hi" };
      for (let i = 0; i < 10; i++) {
        guard.recordResult("exec", args, "hi");
      }
      expect(guard.beforeToolCall("exec", args).action).toBe("continue");
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // NEW: Global circuit breaker
  // ══════════════════════════════════════════════════════════════════════════

  describe("recordResult() — global circuit breaker", () => {
    it("halts when any tool exceeds globalCircuitBreakerThreshold", () => {
      const guard2 = new GuardrailController({ globalCircuitBreakerThreshold: 5 });
      const args = { cmd: "dangerous-loop" };
      for (let i = 0; i < 4; i++) {
        guard2.recordResult("exec", args, "same output");
      }
      const decision = guard2.recordResult("exec", args, "same output");
      expect(decision.action).toBe("halt");
      expect(decision).toHaveProperty("message");
      expect((decision as any).message).toContain("CIRCUIT BREAKER");
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // NEW: Tool call deduplication
  // ══════════════════════════════════════════════════════════════════════════

  describe("deduplicateToolCalls()", () => {
    it("passes through unique calls", () => {
      const calls = [
        { id: "1", name: "web_search", args: { query: "a" } },
        { id: "2", name: "web_search", args: { query: "b" } },
        { id: "3", name: "exec", args: { cmd: "ls" } },
      ];
      const { unique, blocked } = guard.deduplicateToolCalls(calls);
      expect(unique).toHaveLength(3);
      expect(blocked.size).toBe(0);
    });

    it("blocks duplicate calls (same name + same args)", () => {
      const calls = [
        { id: "1", name: "web_search", args: { query: "test" } },
        { id: "2", name: "web_search", args: { query: "test" } },
        { id: "3", name: "web_search", args: { query: "test" } },
      ];
      const { unique, blocked } = guard.deduplicateToolCalls(calls);
      expect(unique).toHaveLength(1);
      expect(unique[0].id).toBe("1");
      expect(blocked.size).toBe(2);
      expect(blocked.has("2")).toBe(true);
      expect(blocked.has("3")).toBe(true);
    });

    it("treats different arg order as same", () => {
      const calls = [
        { id: "1", name: "web_search", args: { query: "a", type: "text" } },
        { id: "2", name: "web_search", args: { type: "text", query: "a" } },
      ];
      const { unique, blocked } = guard.deduplicateToolCalls(calls);
      expect(unique).toHaveLength(1);
      expect(blocked.size).toBe(1);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Config customization
  // ══════════════════════════════════════════════════════════════════════════

  describe("custom config", () => {
    it("respects custom thresholds", () => {
      const custom = new GuardrailController({
        idempotentNoProgressWarnAfter: 3,
        idempotentNoProgressHaltAfter: 6,
      });
      const args = { query: "q" };
      custom.recordResult("web_search", args, "same");
      expect(custom.recordResult("web_search", args, "same").action).toBe("continue");
      expect(custom.recordResult("web_search", args, "same").action).toBe("warn"); // 3rd
      custom.recordResult("web_search", args, "same");
      custom.recordResult("web_search", args, "same");
      expect(custom.recordResult("web_search", args, "same").action).toBe("halt"); // 6th
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Reset behavior
  // ══════════════════════════════════════════════════════════════════════════

  describe("reset()", () => {
    it("clears all state including no-progress tracking", () => {
      guard.recordResult("web_search", { query: "q" }, "same");
      guard.recordResult("web_search", { query: "q" }, "same");
      guard.reset();
      // After reset, should start fresh
      const decision = guard.recordResult("web_search", { query: "q" }, "same");
      expect(decision.action).toBe("continue"); // first call again
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Realistic scenario: web_search loop (the bug we're fixing)
  // ══════════════════════════════════════════════════════════════════════════

  describe("realistic: web_search loop detection", () => {
    it("detects the exact pattern from the bug report", () => {
      // Simulate: model calls web_search with slightly different queries
      // but gets the same garbage results every time
      const garbageResult = `[1] 2025年_百度百科\n2025年是公历平年...\nURL: https://r.bing.com/rs/4e/bP/cc,nc/-G_YKFrphkyl83D0HTgpMefXo7c.css?or=n\n\n[2] 中华人民共和国_百度百科\n...`;

      // Same query, same result — should trigger quickly
      const args = { query: "程序员招聘 2025 北京" };
      guard.recordResult("web_search", args, garbageResult);
      const warn = guard.recordResult("web_search", args, garbageResult);
      expect(warn.action).toBe("warn");

      // Continue with same query...
      guard.recordResult("web_search", args, garbageResult);
      guard.recordResult("web_search", args, garbageResult);
      const halt = guard.recordResult("web_search", args, garbageResult);
      expect(halt.action).toBe("halt");
    });

    it("different queries with same result do NOT trigger (different signatures)", () => {
      const garbageResult = `[1] 百度百科\n...`;
      guard.recordResult("web_search", { query: "query A" }, garbageResult);
      guard.recordResult("web_search", { query: "query B" }, garbageResult);
      guard.recordResult("web_search", { query: "query C" }, garbageResult);
      // No halt because each has a different signature
      const decision = guard.recordResult("web_search", { query: "query D" }, garbageResult);
      expect(decision.action).toBe("continue");
    });
  });
});
