import { describe, it, expect } from "vitest";
import { buildAgentSelectKeyboard } from "../../src/channels/qqbot/api.js";

function mkAgents(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    agentId: `a${i}`,
    agentName: "助手",
    busy: i % 2 === 0,
    topic: `话题${i}`,
  }));
}
function allButtons(kb: any) {
  return kb.content.rows.flatMap((r: any) => r.buttons);
}

describe("buildAgentSelectKeyboard", () => {
  it("includes topic suffix in label to disambiguate same-named agents", () => {
    const kb = buildAgentSelectKeyboard("req1", [
      { agentId: "a0", agentName: "助手", busy: false, topic: "看a股信号" },
    ]);
    const labels = allButtons(kb).map((b: any) => b.render_data.label);
    expect(labels.some((l: string) => l.includes("看a股信号"))).toBe(true);
  });

  it("shows busy/idle marker", () => {
    const kb = buildAgentSelectKeyboard("req1", [
      { agentId: "a0", agentName: "助手", busy: true, topic: "x" },
    ]);
    const labels = allButtons(kb).map((b: any) => b.render_data.label);
    expect(labels.some((l: string) => l.includes("🔴"))).toBe(true);
  });

  it("paginates: with 10 agents page 0 shows a next-page button", () => {
    const kb = buildAgentSelectKeyboard("req1", mkAgents(10), 0);
    const datas = allButtons(kb).map((b: any) => b.action.data);
    expect(datas.some((d: string) => d.startsWith("selagent:req1:page:"))).toBe(true);
  });

  it("page 1 shows the remaining agents and a prev-page button", () => {
    const kb = buildAgentSelectKeyboard("req1", mkAgents(10), 1);
    const datas = allButtons(kb).map((b: any) => b.action.data);
    expect(datas.some((d: string) => d === "selagent:req1:a8")).toBe(true); // a8 on page1
    expect(datas.some((d: string) => d.startsWith("selagent:req1:page:0"))).toBe(true);
  });

  it("single page (≤8 agents) has no page buttons", () => {
    const kb = buildAgentSelectKeyboard("req1", mkAgents(3));
    const datas = allButtons(kb).map((b: any) => b.action.data);
    expect(datas.some((d: string) => d.includes(":page:"))).toBe(false);
  });

  it("still includes a back button", () => {
    const kb = buildAgentSelectKeyboard("req1", mkAgents(3));
    const datas = allButtons(kb).map((b: any) => b.action.data);
    expect(datas).toContain("selagent:req1:back");
  });
});
