// src/agent/command-parser.ts
// 斜杠命令解析器 — 将用户输入的 /xxx 命令解析为工具调用参数

// Valid slash command: /word (only letters, digits, hyphens after the slash)
// File paths like /usr/bin/foo or /home/user do NOT match.
const SLASH_CMD_RE = /^\/[a-zA-Z][a-zA-Z0-9_-]*(\s|$)/;

export class CommandParser {
  static isCommand(content: unknown): boolean {
    if (typeof content !== "string") return false;
    return SLASH_CMD_RE.test(content.trim());
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
