// src/guidance/mem-intent.ts
export interface MemIntent {
  action: "enter" | "exit"
}

const ENTER_RE = /(整理|梳理).*(记忆|工作记忆)|记忆管理|管理.*记忆/
const EXIT_RE = /退出.*记忆|结束.*记忆管理/

export function resolveMemIntent(text: string): MemIntent | null {
  const t = text.trim()
  if (t === "/mem" || t.startsWith("/mem ")) return { action: "enter" }
  if (t === "/exit" || EXIT_RE.test(t)) return { action: "exit" }
  if (ENTER_RE.test(t)) return { action: "enter" }
  return null
}
