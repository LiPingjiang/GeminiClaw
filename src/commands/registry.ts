// @ts-nocheck
// src/commands/registry.ts
// Declarative command registry — single source of truth.
// To add a command: add a CommandDef entry to COMMAND_REGISTRY.
export const COMMAND_REGISTRY = [
    // ── Session ──────────────────────────────────────────────────────────────
    {
        name: "new",
        alias: "n",
        description: "清空记忆，开始新对话",
        category: "session",
    },
    {
        name: "undo",
        alias: "u",
        description: "撤销上一轮对话",
        category: "session",
    },
    {
        name: "stop",
        description: "停止当前请求（进行中）",
        category: "session",
    },
    // ── Config ───────────────────────────────────────────────────────────────
    {
        name: "model",
        alias: "m",
        description: "查看/切换模型",
        argsHint: "[编号]",
        category: "config",
    },
    // ── System ───────────────────────────────────────────────────────────────
    {
        name: "exec",
        alias: "x",
        description: "执行 shell 命令",
        argsHint: "<命令>",
        category: "system",
    },
    {
        name: "status",
        alias: "s",
        description: "查看运行状态",
        category: "system",
    },
    {
        name: "help",
        alias: "h",
        description: "显示帮助",
        category: "system",
    },
];
/** Look up a CommandDef by full name or alias (case-insensitive). */
export function resolveCommand(input) {
    const lower = input.toLowerCase();
    return (COMMAND_REGISTRY.find((c) => c.name === lower || c.alias === lower) ?? null);
}
/** Auto-generate help text from the registry. */
export function buildHelpText() {
    const categories = {};
    for (const cmd of COMMAND_REGISTRY) {
        ;
        (categories[cmd.category] ??= []).push(cmd);
    }
    const lines = ["可用命令：", ""];
    const labels = {
        session: "对话管理",
        config: "配置",
        system: "系统",
    };
    for (const [cat, cmds] of Object.entries(categories)) {
        lines.push(`[ ${labels[cat] ?? cat} ]`);
        for (const cmd of cmds) {
            const aliasStr = cmd.alias ? `/${cmd.alias}` : "   ";
            const argsStr = cmd.argsHint ? ` ${cmd.argsHint}` : "";
            lines.push(`  /${cmd.name}${argsStr}  ${aliasStr}  ${cmd.description}`);
        }
        lines.push("");
    }
    lines.push("提示：别名更短，手机输入更方便。");
    lines.push("示例：/m 1 切换到第 1 个模型，/x pwd 查看当前目录");
    return lines.join("\n").trimEnd();
}
