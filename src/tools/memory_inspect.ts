// @ts-nocheck
// src/tools/memory_inspect.ts
// Tool: read-only overview of all memory layers (for the memory-steward agent).
import { registry } from "./registry.js";
import { MemoryPaths } from "../memory/paths.js";
import { WorkingMemoryBuilder } from "../memory/working-memory.js";

registry.register({
  name: "memory_inspect",
  description:
    "查看记忆全景：全局固定区(AGENT.md)、全局非固定区(长期记忆/日记)、当前助手私人固定区、私人非固定区，以及公共知识库。layer 可选 all/global_fixed/global_nonfixed/agent_fixed/agent_nonfixed/public。仅在记忆管理会话中使用。",
  schema: {
    type: "object",
    properties: {
      layer: {
        type: "string",
        description:
          "要查看的层：all（默认）/global_fixed/global_nonfixed/agent_fixed/agent_nonfixed/public",
      },
    },
    required: [],
  },
  handler: async (params, ctx) => {
    const root = ctx.extra?.memoryRoot as string | undefined;
    const targetAgentId = ctx.extra?.targetAgentId as string | undefined;
    const db = ctx.extra?.db;
    const paths = new MemoryPaths(root);
    const wm = new WorkingMemoryBuilder(paths);
    const date = new Date().toISOString().slice(0, 10);
    const mem = wm.build(targetAgentId ?? "__none__", date);
    const contextWindow =
      (ctx.extra?.contextWindow as number | undefined) ?? 200_000;

    const layer = (params.layer as string) || "all";
    const want = (k: string) => layer === "all" || layer === k;
    const sections: string[] = [];

    if (want("global_fixed"))
      sections.push(`# 全局固定区（不可压缩）\n${mem.globalFixed || "(空)"}`);
    if (want("global_nonfixed"))
      sections.push(`# 全局非固定区（可压缩）\n${mem.globalNonFixed || "(空)"}`);
    if (want("agent_fixed"))
      sections.push(`# 私人固定区（不可压缩）\n${mem.agentFixed || "(空)"}`);
    if (want("agent_nonfixed"))
      sections.push(`# 私人非固定区（可压缩）\n${mem.agentNonFixed || "(空)"}`);

    if (want("public") && db) {
      const rows = db
        .prepare(
          `SELECT id, title, doc_size FROM public_knowledge WHERE active = 1 ORDER BY last_accessed_at DESC`,
        )
        .all() as Array<{ id: string; title: string; doc_size: number }>;
      const list = rows
        .map((r) => `- [${r.id}] ${r.title}（${r.doc_size}B）`)
        .join("\n");
      sections.push(`# 公共知识库\n${list || "(空)"}`);
    }

    let out = sections.join("\n\n---\n\n");
    if (layer === "all") {
      const usage = wm.renderUsageSummary(
        targetAgentId ?? "__none__",
        date,
        contextWindow,
      );
      out = `${usage}\n\n---\n\n${out}`;
    }
    return { type: "text", text: out };
  },
});
