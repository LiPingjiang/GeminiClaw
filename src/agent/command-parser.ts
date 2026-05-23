// src/agent/command-parser.ts
// 斜杠命令解析器 — 将用户输入的 /xxx 命令解析为工具调用参数

export class CommandParser {
  /**
   * 判断消息是否为斜杠命令
   */
  static isCommand(content: unknown): boolean {
    if (typeof content !== 'string') return false
    return content.trim().startsWith('/')
  }

  /**
   * 将命令字符串解析为工具调用参数
   * 例："/进化 预览 1" → { command: "进化", args: ["预览", "1"] }
   */
  static toToolCallArgs(content: string): { command: string; args: string[] } | null {
    const trimmed = content.trim()
    if (!trimmed.startsWith('/')) return null

    const parts = trimmed.slice(1).trim().split(/\s+/)
    if (parts.length === 0 || !parts[0]) return null

    const command = parts[0]
    const args = parts.slice(1)
    return { command, args }
  }
}
