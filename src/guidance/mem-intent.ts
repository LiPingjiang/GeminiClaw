// src/guidance/mem-intent.ts
export interface MemIntent {
  action: "enter" | "exit"
}

const ENTER_RE = /(整理|梳理).*(记忆|工作记忆)|记忆管理|管理.*记忆/
const EXIT_RE = /退出.*记忆|结束.*记忆管理|不整理了|不管理了/
// Short, standalone "go back / return to the assistant" utterances. Kept tight
// (exact match after trim) so normal chat like "返回结果是什么" is never caught.
const BACK_WORDS = new Set([
  "返回",
  "回去",
  "切回",
  "切回助手",
  "返回助手",
  "回到助手",
  "回到对话",
  "退出",
  "结束",
  "退出管理",
])

export function resolveMemIntent(text: string): MemIntent | null {
  const t = text.trim()
  if (t === "/mem" || t.startsWith("/mem ")) return { action: "enter" }
  if (t === "/exit" || t === "/back" || t === "/q") return { action: "exit" }
  if (EXIT_RE.test(t) || BACK_WORDS.has(t)) return { action: "exit" }
  if (ENTER_RE.test(t)) return { action: "enter" }
  return null
}
