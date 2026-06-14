// src/tools/agent_memory.ts
// Tool: Lazy-load memory for sub-agents.
// Instead of injecting all memory into the system prompt (token-expensive),
// sub-agents can call this tool on-demand to read specific memory sections.
//
// This implements the "memory as tool" pattern from OpenClaw:
// - Sub-agent starts with minimal context
// - If it needs background info, it calls agent_memory to fetch it
// - Saves tokens when the memory isn't needed

import { registry } from "./registry.js"
import { existsSync, readFileSync, readdirSync } from "fs"
import { join } from "path"
import os from "os"

const MEMORY_ROOT = join(os.homedir(), ".gemeniclaw")

registry.register({
  name: "agent_memory",
  description:
    "按需读取记忆内容。可读取全局记忆、指定 agent 的私人记忆、或当日日记。" +
    "当你需要了解背景信息、历史决策、用户偏好时调用此工具，而不是猜测。" +
    "支持的 section: global_fixed（全局身份）、global_memory（全局长期记忆）、" +
    "global_today（全局当日日记）、agent_fixed（agent身份）、agent_memory（agent长期记忆）、" +
    "agent_today（agent当日日记）、agent_list（列出所有agent）。",
  schema: {
    type: "object",
    properties: {
      section: {
        type: "string",
        enum: [
          "global_fixed",
          "global_memory",
          "global_today",
          "agent_fixed",
          "agent_memory",
          "agent_today",
          "agent_list",
        ],
        description: "要读取的记忆区域",
      },
      agent_id: {
        type: "string",
        description: "目标 agent ID（读取 agent_* 区域时必填）",
      },
    },
    required: ["section"],
  },
  handler: async (params) => {
    const section = String(params.section || "")
    const agentId = params.agent_id ? String(params.agent_id) : undefined
    const today = new Date().toISOString().slice(0, 10)

    const readIf = (path: string): string => {
      if (!existsSync(path)) return ""
      try {
        return readFileSync(path, "utf-8").trim()
      } catch {
        return ""
      }
    }

    switch (section) {
      case "global_fixed": {
        const content = readIf(join(MEMORY_ROOT, "AGENT.md"))
        return {
          type: "text",
          text: content || "(全局固定区为空)",
        }
      }
      case "global_memory": {
        const content = readIf(join(MEMORY_ROOT, "memory", "global", "MEMORY.md"))
        return {
          type: "text",
          text: content || "(全局长期记忆为空)",
        }
      }
      case "global_today": {
        const content = readIf(join(MEMORY_ROOT, "memory", "global", "daily", `${today}.md`))
        return {
          type: "text",
          text: content || `(今日 ${today} 全局日记为空)`,
        }
      }
      case "agent_fixed": {
        if (!agentId) {
          return { type: "error", error: "agent_fixed 需要提供 agent_id" }
        }
        const content = readIf(join(MEMORY_ROOT, "agents", agentId, "AGENT.md"))
        return {
          type: "text",
          text: content || `(agent ${agentId} 固定区为空)`,
        }
      }
      case "agent_memory": {
        if (!agentId) {
          return { type: "error", error: "agent_memory 需要提供 agent_id" }
        }
        const content = readIf(join(MEMORY_ROOT, "agents", agentId, "MEMORY.md"))
        return {
          type: "text",
          text: content || `(agent ${agentId} 长期记忆为空)`,
        }
      }
      case "agent_today": {
        if (!agentId) {
          return { type: "error", error: "agent_today 需要提供 agent_id" }
        }
        const content = readIf(
          join(MEMORY_ROOT, "agents", agentId, "daily", `${today}.md`),
        )
        return {
          type: "text",
          text: content || `(agent ${agentId} 今日 ${today} 日记为空)`,
        }
      }
      case "agent_list": {
        const agentsDir = join(MEMORY_ROOT, "agents")
        if (!existsSync(agentsDir)) {
          return { type: "text", text: "(无已注册 agent)" }
        }
        try {
          const agents = readdirSync(agentsDir).filter((d) => {
            try {
              return existsSync(join(agentsDir, d, "AGENT.md"))
            } catch {
              return false
            }
          })
          if (agents.length === 0) {
            return { type: "text", text: "(无已注册 agent)" }
          }
          return {
            type: "text",
            text: `已注册 agent (${agents.length}):\n${agents.map((a) => `- ${a}`).join("\n")}`,
          }
        } catch {
          return { type: "text", text: "(读取 agent 列表失败)" }
        }
      }
      default:
        return { type: "error", error: `未知 section: ${section}` }
    }
  },
})
