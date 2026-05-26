// src/agent/command-parser.ts
// 斜杠命令解析器 — 将用户输入的 /xxx 命令解析为工具调用参数

export class CommandParser {
  static isCommand(content: unknown): boolean {
    if (typeof content !== "string") return false;
    return content.trim().startsWith("/");
  }

  static toToolCallArgs(
    content: string,
  ): { command: string; args: string[] } | null {
    const trimmed = content.trim();
    if (!trimmed.startsWith("/")) return null;
    const parts = trimmed.slice(1).trim().split(/\s+/);
    if (parts.length === 0 || !parts[0]) return null;
    const command = parts[0];
    const args = parts.slice(1);
    return { command, args };
  }
}
