/**
 * replay-session.ts
 * 回放指定 session 的某个 turn，保存实际发给 Claude 的 prompt 和回复到文件
 *
 * 用法：npx tsx scripts/replay-session.ts <sessionId> <upToMsgId>
 * 示例：npx tsx scripts/replay-session.ts 5fbb3c60-17c6-43bd-b503-04abfc8c250b 844
 */

import { existsSync, readFileSync, writeFileSync } from "fs"
import { join } from "path"
import os from "os"
import Database from "better-sqlite3"

// ── Config ────────────────────────────────────────────────────────────────
const SESSION_ID = process.argv[2] ?? "5fbb3c60-17c6-43bd-b503-04abfc8c250b"
const UP_TO_MSG_ID = Number(process.argv[3] ?? 844)  // 包含这条 user msg，不含之后的
const OUTPUT_FILE = `/tmp/replay-${SESSION_ID.slice(0, 8)}-msg${UP_TO_MSG_ID}.json`

const DB_PATH = join(os.homedir(), ".gemeniclaw", "memory", "geminiclaw.db")
const AGENT_MD_PATH = join(os.homedir(), ".gemeniclaw", "AGENT.md")

// mcli / Anthropic proxy config
const BASE_URL = "http://127.0.0.1:15231"
const API_KEY = "91d7de174f60430198eaeaf8ee48be72"
const MODEL = "claude-opus-4-6"
const MAX_TOKENS = 4096

// ── Load system prompt ────────────────────────────────────────────────────
function loadSystemPrompt(): string {
  if (existsSync(AGENT_MD_PATH)) {
    return readFileSync(AGENT_MD_PATH, "utf-8").trim()
  }
  return "你是 GeminiClaw，一个智能 AI 助手。"
}

// ── Load session messages from DB ─────────────────────────────────────────
interface DbRow {
  id: number
  role: string
  content: string
  tool_calls: string | null
  tool_call_id: string | null
}

function loadMessages(sessionId: string, upToId: number): DbRow[] {
  const db = new Database(DB_PATH, { readonly: true })
  const rows = db.prepare(`
    SELECT id, role, content, tool_calls, tool_call_id
    FROM chat_messages
    WHERE session_id = ? AND id <= ?
    ORDER BY id ASC
  `).all(sessionId, upToId) as DbRow[]
  db.close()
  return rows
}

// ── Build Anthropic messages array ────────────────────────────────────────
interface AnthropicMessage {
  role: "user" | "assistant"
  content: string | Array<{ type: string; [k: string]: unknown }>
}

function buildAnthropicMessages(rows: DbRow[]): AnthropicMessage[] {
  const messages: AnthropicMessage[] = []
  for (const row of rows) {
    if (row.role === "system") continue  // system → separate field
    if (row.role === "user" || row.role === "assistant") {
      messages.push({ role: row.role as "user" | "assistant", content: row.content })
    }
    // tool_calls / tool results ignored for simplicity in replay
  }
  return messages
}

// ── Call Anthropic Messages API ───────────────────────────────────────────
async function callClaude(systemPrompt: string, messages: AnthropicMessage[]) {
  const body = {
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system: systemPrompt,
    messages,
  }

  const res = await fetch(`${BASE_URL}/v1/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": API_KEY,
      "anthropic-version": "2023-06-01",
      "X-Working-Dir": "/Users/lipingjiang",
    },
    body: JSON.stringify(body),
  })

  if (!res.ok) {
    const err = await res.text()
    throw new Error(`API error ${res.status}: ${err}`)
  }

  return res.json()
}

// ── Main ──────────────────────────────────────────────────────────────────
async function main() {
  console.log(`Session: ${SESSION_ID}`)
  console.log(`Replaying up to message id: ${UP_TO_MSG_ID}`)

  const systemPrompt = loadSystemPrompt()
  const rows = loadMessages(SESSION_ID, UP_TO_MSG_ID)
  const messages = buildAnthropicMessages(rows)

  console.log(`\nDB messages loaded: ${rows.length} rows → ${messages.length} Anthropic messages`)
  console.log(`System prompt length: ${systemPrompt.length} chars`)
  console.log(`Last message: [${messages.at(-1)?.role}] ${String(messages.at(-1)?.content).slice(0, 80)}...`)

  console.log(`\nCalling Claude ${MODEL}...`)
  const response = await callClaude(systemPrompt, messages)

  const output = {
    meta: {
      sessionId: SESSION_ID,
      upToMsgId: UP_TO_MSG_ID,
      model: MODEL,
      timestamp: new Date().toISOString(),
    },
    request: {
      systemPrompt,
      systemPromptLength: systemPrompt.length,
      messages,
      messageCount: messages.length,
    },
    response,
    responseText: response?.content?.[0]?.text ?? "(no text)",
  }

  writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2), "utf-8")
  console.log(`\n✅ Saved to ${OUTPUT_FILE}`)
  console.log(`\n── Claude's response ──────────────────────────────────`)
  console.log(output.responseText)
}

main().catch(e => { console.error(e); process.exit(1) })
