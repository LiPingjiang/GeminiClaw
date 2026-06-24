/**
 * 完整验证 v2：传真实 tools，执行真实 bash，对比旧/新 system prompt
 *
 * 场景 A（更接近原始失败）：
 *   用 tool_result 把5行代码注入到 Claude 的 context 里
 *   （模拟之前 bash 工具读过文件、结果在 context 中的状态）
 *   然后问"看一下上下20行"
 *   → 新 prompt 应重新读文件展示完整20行
 *   → 旧 prompt 可能从 context 里摘5行了事
 *
 * 场景 B（基础验证）：
 *   context 里没有任何文件内容，问"帮我看一下 L144 上下20行"
 *   → 两个 prompt 都应该调工具读文件
 */

import { execSync } from "child_process"
import fs from "fs"

const BASE_URL = "http://127.0.0.1:15231"
const API_KEY = "91d7de174f60430198eaeaf8ee48be72"
const MODEL = "claude-opus-4-6"
const MAX_TURNS = 6

const TOOLS = [
  {
    name: "bash",
    description: "在本地 Mac 上运行 bash 命令，返回 stdout + stderr。",
    input_schema: {
      type: "object",
      properties: {
        command: { type: "string", description: "要执行的 bash 命令" },
      },
      required: ["command"],
    },
  },
]

function runBash(command) {
  try {
    return execSync(command, { encoding: "utf-8", timeout: 10_000, stdio: ["pipe","pipe","pipe"] })
  } catch (e) {
    return (e.stdout ?? "") + (e.stderr ? "\n[stderr] " + e.stderr : "")
  }
}

// 文件真实路径
const SQL_FILE = "/Users/lipingjiang/Codes/search-data-querytools/query-tools-service/src/main/resources/sql/query-card.sql"

// 5行代码片段（真实内容，模拟之前 bash 只读了5行的情况）
const TOOL_RESULT_SNIPPET = `               sum(new_search_qv) / max(date_cnt) as searchQv,
               sum(search_uv) / max(date_cnt) as searchUv,
               1.0 * sum(click_qv) / sum(new_search_qv) as validQvCtr,
               1.0 * sum(result_valid_click_qv) / sum(result_search_qv) as resultValidQvCtr,
               sum(click_uv) / max(date_cnt) as validClickUv,`

// ── 场景 A：tool_result 里有5行内容（含真实路径），问20行 ───────────────
const MESSAGES_SCENARIO_A = [
  { role: "user", content: `帮我看一下 ${SQL_FILE} 里 L144 附近几行` },
  {
    role: "assistant",
    content: [
      { type: "text", text: "好，我来读一下文件：" },
      {
        type: "tool_use",
        id: "tool_fake_001",
        name: "bash",
        input: { command: `sed -n '141,145p' ${SQL_FILE}` },
      },
    ],
  },
  {
    role: "user",
    content: [
      {
        type: "tool_result",
        tool_use_id: "tool_fake_001",
        content: TOOL_RESULT_SNIPPET,   // ← 只有5行，不完整
      },
    ],
  },
  {
    role: "assistant",
    content: `代码看到了（L141-L145）：

\`\`\`sql
${TOOL_RESULT_SNIPPET}
\`\`\`

L144 是 \`resultValidQvCtr\`，分母是 \`result_search_qv\`。`,
  },
  {
    role: "user",
    content: "看一下上下20行",  // ← 测试点：会重新读文件还是从这5行摘录?
  },
]

// ── 场景 B：没有任何文件内容，从零开始读 ────────────────────────────────
const MESSAGES_SCENARIO_B = [
  {
    role: "user",
    content: `帮我看一下 ${SQL_FILE} 里 L144 上下20行`,
  },
]

// ── agentic loop ──────────────────────────────────────────────────────────
async function runAgentLoop(systemPrompt, label, messages) {
  const log = []
  let msgs = [...messages]
  let toolCallCount = 0
  let finalText = null

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const body = { model: MODEL, max_tokens: 1500, system: systemPrompt, tools: TOOLS, messages: msgs }
    const res = await fetch(`${BASE_URL}/v1/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": API_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify(body),
    })
    if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`)
    const data = await res.json()
    const content = data.content ?? []
    log.push({ turn, stopReason: data.stop_reason, content })

    if (data.stop_reason === "tool_use") {
      const toolBlocks = content.filter(b => b.type === "tool_use")
      toolCallCount += toolBlocks.length
      msgs.push({ role: "assistant", content })
      const results = toolBlocks.map(b => {
        const cmd = b.input?.command ?? ""
        const result = runBash(cmd)
        log.push({ toolName: b.name, command: cmd, result: result.slice(0, 3000) })
        return { type: "tool_result", tool_use_id: b.id, content: result }
      })
      msgs.push({ role: "user", content: results })
    } else {
      finalText = content.filter(b => b.type === "text").map(b => b.text).join("\n")
      break
    }
  }
  return { label, toolCallCount, finalText, log }
}

// ── System prompts ─────────────────────────────────────────────────────────
const OLD_SYSTEM = `你是 GeminiClaw，一个智能 AI Agent，运行在本地 Mac 上。
你有 bash 工具可以执行命令和读取文件。`

const { buildSystemPrompt } = await import(
  "/Users/lipingjiang/Codes/GeminiClaw/dist/system-prompt/builder.js"
)
const NEW_SYSTEM = buildSystemPrompt("mcli/claude-opus-4-6")

// ── 运行4组对比 ────────────────────────────────────────────────────────────
console.log("=== 完整验证 v2 ===")
console.log(`OLD: ${OLD_SYSTEM.length} chars | NEW: ${NEW_SYSTEM.length} chars`)
console.log("运行4组对比（并行）...\n")

const [oldA, newA, oldB, newB] = await Promise.all([
  runAgentLoop(OLD_SYSTEM, "旧prompt·场景A", MESSAGES_SCENARIO_A),
  runAgentLoop(NEW_SYSTEM, "新prompt·场景A", MESSAGES_SCENARIO_A),
  runAgentLoop(OLD_SYSTEM, "旧prompt·场景B", MESSAGES_SCENARIO_B),
  runAgentLoop(NEW_SYSTEM, "新prompt·场景B", MESSAGES_SCENARIO_B),
])

// ── 打印 ──────────────────────────────────────────────────────────────────
function printResult(r) {
  console.log(`\n${"═".repeat(55)}`)
  console.log(`【${r.label}】工具调用 ${r.toolCallCount} 次`)
  r.log.filter(e => e.command).forEach(e => {
    console.log(`  $ ${e.command.slice(0, 80)}`)
    const lines = e.result.trim().split("\n").length
    console.log(`  → ${lines} 行输出`)
  })
  const finalLines = (r.finalText ?? "").split("\n").length
  console.log(`最终回复 ${finalLines} 行`)
  // 只印前20行最终回复
  console.log((r.finalText ?? "").split("\n").slice(0,20).join("\n"))
}

printResult(oldA); printResult(newA)
printResult(oldB); printResult(newB)

// ── 断言 ──────────────────────────────────────────────────────────────────
console.log(`\n${"═".repeat(55)}`)
console.log("【断言验证】")

// 场景A：关键测试——有 in-context tool_result 时
const oldAToolCalls = oldA.toolCallCount
const newAToolCalls = newA.toolCallCount
const newAFinalLines = (newA.finalText ?? "").split("\n").length

// 从 log 里拿 bash 返回的行数
const getBashLines = (r) => {
  const bashLogs = r.log.filter(e => e.result)
  if (bashLogs.length === 0) return 0
  return Math.max(...bashLogs.map(e => e.result.trim().split("\n").length))
}

const oldABashLines = getBashLines(oldA)
const newABashLines = getBashLines(newA)
const oldBBashLines = getBashLines(oldB)
const newBBashLines = getBashLines(newB)

const checks = {
  // 场景A（核心场景：context 里有 tool_result 5行）
  "[A] 新prompt 重新调了 bash": newAToolCalls >= 1,
  "[A] 新prompt bash 读到 ≥15 行代码": newABashLines >= 15,
  "[A] 新prompt 最终回复 ≥15 行": newAFinalLines >= 15,
  // 场景B（基础场景）
  "[B] 旧prompt 能正常调工具": oldBBashLines >= 10,
  "[B] 新prompt 能正常调工具": newBBashLines >= 10,
  "[B] 两个 prompt 都拿到了 ≥20 行代码": oldBBashLines >= 20 && newBBashLines >= 20,
}

let allPass = true
for (const [name, result] of Object.entries(checks)) {
  const icon = result ? "✅" : "❌"
  console.log(`${icon} ${name}`)
  if (!result) allPass = false
}

// 附加：场景A对比（不做断言，只观察）
console.log(`\n场景A对比（context 有5行 tool_result 时）：`)
console.log(`  旧prompt 工具调用=${oldAToolCalls} bash最多=${oldABashLines}行`)
console.log(`  新prompt 工具调用=${newAToolCalls} bash最多=${newABashLines}行`)

fs.writeFileSync("/tmp/verify_full_v2.json", JSON.stringify({ oldA, newA, oldB, newB }, null, 2))
console.log("\n结果保存至 /tmp/verify_full_v2.json")
console.log("\n结论:", allPass ? "✅ 验证通过" : "❌ 有断言未通过")
