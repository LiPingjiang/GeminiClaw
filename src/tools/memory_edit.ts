// @ts-nocheck
// src/tools/memory_edit.ts
// Tool: write to a memory layer. Fixed layers (AGENT.md) require confirm=true.
import { registry } from "./registry.js";
import { MemoryPaths } from "../memory/paths.js";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "fs";
import { dirname } from "path";

const FIXED_LAYERS = new Set(["global_fixed", "agent_fixed"]);

function pathFor(
  layer: string,
  paths: MemoryPaths,
  agentId: string | undefined,
  date: string,
): string | null {
  switch (layer) {
    case "global_fixed":
      return paths.globalAgentMd();
    case "global_nonfixed":
      return paths.globalMemoryMd();
    case "global_daily":
      return paths.globalDaily(date);
    case "agent_fixed":
      return agentId ? paths.agentAgentMd(agentId) : null;
    case "agent_nonfixed":
      return agentId ? paths.agentMemoryMd(agentId) : null;
    case "agent_daily":
      return agentId ? paths.agentDaily(agentId, date) : null;
    default:
      return null;
  }
}

registry.register({
  name: "memory_edit",
  description:
    "编辑记忆层。layer: global_nonfixed/global_daily/agent_nonfixed/agent_daily（可压缩区，自由编辑）；global_fixed/agent_fixed（固定区，需 confirm=true 才允许，谨慎修改身份约束）。mode: replace 覆盖 / append 追加。仅在记忆管理会话中使用。",
  schema: {
    type: "object",
    properties: {
      layer: { type: "string", description: "目标记忆层" },
      mode: {
        type: "string",
        enum: ["replace", "append"],
        description: "写入方式",
      },
      content: { type: "string", description: "要写入的内容" },
      confirm: { type: "boolean", description: "修改固定区时必须为 true" },
    },
    required: ["layer", "mode", "content"],
  },
  handler: async (params, ctx) => {
    const root = ctx.extra?.memoryRoot as string | undefined;
    const targetAgentId = ctx.extra?.targetAgentId as string | undefined;
    const paths = new MemoryPaths(root);
    const date = new Date().toISOString().slice(0, 10);
    const layer = params.layer as string;
    const mode = (params.mode as string) || "replace";
    const content = (params.content as string) ?? "";

    if (FIXED_LAYERS.has(layer) && params.confirm !== true) {
      return {
        type: "error",
        error: `修改固定区(${layer})会影响助手身份/约束，需传 confirm=true 二次确认。`,
      };
    }

    const file = pathFor(layer, paths, targetAgentId, date);
    if (!file) {
      return {
        type: "error",
        error: `未知或不可用的记忆层: ${layer}（agent 类层需要 targetAgentId）`,
      };
    }

    mkdirSync(dirname(file), { recursive: true });
    const final =
      mode === "append" && existsSync(file)
        ? readFileSync(file, "utf-8").trimEnd() + "\n\n" + content
        : content;
    writeFileSync(file, final, "utf-8");
    const bytes = Buffer.byteLength(final);
    ctx.logger.info(`[memory_edit] wrote ${layer} (${bytes}B) → ${file}`);
    return {
      type: "text",
      text: `已${mode === "append" ? "追加到" : "更新"} ${layer}（${bytes} 字节）。`,
    };
  },
});
