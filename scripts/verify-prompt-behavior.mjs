/**
 * 验证新旧系统 prompt 的行为差异
 * 场景：Claude 已在 context 里有文件内容（模拟 tool output），
 *       用户说"看一下上下20行"——新 prompt 应让 Claude 调工具重读，旧 prompt 不会
 */

import fs from "fs"
import path from "path"
import os from "os"

const BASE_URL = "http://127.0.0.1:15231"
const API_KEY = "91d7de174f60430198eaeaf8ee48be72"
const MODEL = "claude-opus-4-6"

// 模拟真实会话里 Claude 之前读到的文件片段（只有5行，上下文不完整）
const FILE_CONTEXT_IN_MEMORY = `
-- L141
sum(new_search_qv) / max(date_cnt) as searchQv,
-- L142
sum(search_uv) / max(date_cnt) as searchUv,
-- L143
1.0 * sum(click_qv) / sum(new_search_qv) as validQvCtr,
-- L144 ❌ 问题行
1.0 * sum(result_valid_click_qv) / sum(new_search_qv) as resultValidQvCtr,
-- L145
sum(click_uv) / max(date_cnt) as validClickUv,
`.trim()

// 构造对话：模拟 Claude 之前读过文件（在 assistant 消息里引用了代码）
const MESSAGES_WITH_FILE_IN_CONTEXT = [
  {
    role: "user",
    content: "看一下 query-card.sql 里 L144 上下几行的代码",
  },
  {
    role: "assistant",
    content: `代码看到了，来分析一下 L144 的上下文：

\`\`\`sql
${FILE_CONTEXT_IN_MEMORY}
\`\`\`

关键发现：这个 \`total\` 子查询用的是 \`new_search_qv\` 这套字段体系，分母不是 \`result_qv\`。`,
  },
  {
    role: "user",
    content: "看一下上下20行",  // ← 测试点：Claude 会重读文件还是从 context 摘录？
  },
]

async function call(systemPrompt, label) {
  const body = {
    model: MODEL,
    max_tokens: 800,
    system: systemPrompt,
    messages: MESSAGES_WITH_FILE_IN_CONTEXT,
  }

  const res = await fetch(`${BASE_URL}/v1/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
  })

  const data = await res.json()
  const text = data?.content?.[0]?.text ?? "(no text)"
  return { label, text, tokens: data?.usage }
}

// ── 旧 system prompt（不含 MANDATORY_TOOL_USE）────────────────────────────
const OLD_SYSTEM = `你是 GeminiClaw，一个智能 AI Agent。

## 执行诚信协议（硬约束）
声称"完成"前必须满足：工具输出显示成功，关键步骤有验证命令输出佐证。`

// ── 新 system prompt（含 MANDATORY_TOOL_USE，从代码读取）────────────────────
// 动态加载 builder 输出
const { buildSystemPrompt } = await import(
  "/Users/lipingjiang/Codes/GeminiClaw/dist/system-prompt/builder.js"
)
const NEW_SYSTEM = buildSystemPrompt("mcli/claude-opus-4-6")

console.log("=== 系统 prompt 对比 ===")
console.log("OLD length:", OLD_SYSTEM.length)
console.log("NEW length:", NEW_SYSTEM.length)
console.log("NEW 含 mandatory_tool_use:", NEW_SYSTEM.includes("mandatory_tool_use"))
console.log()

// ── 并行调两次 API ────────────────────────────────────────────────────────
console.log("调用 Claude（两次，并行）...")
const [oldResult, newResult] = await Promise.all([
  call(OLD_SYSTEM, "旧 prompt（无 MANDATORY_TOOL_USE）"),
  call(NEW_SYSTEM, "新 prompt（含 MANDATORY_TOOL_USE）"),
])

const output = { old: oldResult, new: newResult }
const outPath = "/tmp/verify_prompt_result.json"
fs.writeFileSync(outPath, JSON.stringify(output, null, 2))

console.log("\n════════════════════════════════════════")
console.log("【旧 prompt 的回复】")
console.log("────────────────────────────────────────")
console.log(oldResult.text)
console.log("\n【新 prompt 的回复】")
console.log("────────────────────────────────────────")
console.log(newResult.text)
console.log("\n结果已保存到", outPath)
