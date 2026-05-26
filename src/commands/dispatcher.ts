// @ts-nocheck
// src/commands/dispatcher.ts
// Parse incoming text, dispatch to the right handler, return reply string.
// Returns null if the message is NOT a command (let LLM handle it).
import { exec as nodeExec } from "child_process";
import { promisify } from "util";
import { resolveCommand, buildHelpText } from "./registry.js";
const execAsync = promisify(nodeExec);
/** Parse "/cmd arg1 arg2" → { name, args } or null if not a command. */
function parseInput(text) {
    const trimmed = text.trim();
    if (!trimmed.startsWith("/"))
        return null;
    const [rawCmd, ...args] = trimmed.slice(1).split(/\s+/);
    if (!rawCmd)
        return null;
    return { name: rawCmd, args };
}
/** Main entry point. Returns reply string or null (not a command). */
export async function dispatch(text, ctx) {
    const parsed = parseInput(text);
    if (!parsed)
        return null;
    const def = resolveCommand(parsed.name);
    if (!def) {
        // Unknown command — let LLM handle naturally, don't intercept
        return null;
    }
    const { openid, memory, config, modelOverrides, startedAt } = ctx;
    const args = parsed.args; // ← 用解析出来的参数，而不是 ctx.args
    switch (def.name) {
        // ── /new ────────────────────────────────────────────────────────────────
        case "new": {
            await memory.ensureSession(openid);
            // Replace session with a fresh empty one
            if (typeof memory.resetSession === "function") {
                await memory.resetSession(openid);
            }
            else {
                // Fallback: append a system note that memory was cleared
                // (LayeredStrategy may not expose resetSession yet)
                await memory.appendTurn(openid, { role: "user", content: "[系统：用户请求清空记忆]" }, { role: "assistant", content: "[已清空本轮对话记忆，开始新对话]" });
            }
            return "已清空记忆，开始新对话。";
        }
        // ── /undo ───────────────────────────────────────────────────────────────
        case "undo": {
            if (typeof memory.undoLastTurn === "function") {
                const ok = await memory.undoLastTurn(openid);
                return ok ? "已撤销上一轮对话。" : "没有可撤销的对话。";
            }
            return "当前记忆策略暂不支持撤销。";
        }
        // ── /stop ───────────────────────────────────────────────────────────────
        case "stop": {
            // TODO: signal the agent loop to abort current run
            return "停止信号已发送（功能开发中，当前请求若已完成则无效）。";
        }
        // ── /model ──────────────────────────────────────────────────────────────
        case "model": {
            const allModels = config.providers.flatMap((p) => p.models.map((m) => `${p.name}/${m}`));
            const currentOverride = modelOverrides.get(openid);
            const currentModel = currentOverride ?? config.routing.default;
            // /m 或 /m 0 → 显示列表
            if (args.length === 0 || args[0] === "0") {
                const lines = [`当前模型: ${currentModel}`, ""];
                allModels.forEach((m, i) => {
                    const marker = m === currentModel ? " ←" : "";
                    lines.push(`${i + 1}. ${m}${marker}`);
                });
                lines.push("", "发送 /m <编号> 切换，例如 /m 1");
                return lines.join("\n");
            }
            // /m <编号> → 切换
            const idx = parseInt(args[0], 10);
            if (!isNaN(idx) && idx >= 1 && idx <= allModels.length) {
                const selected = allModels[idx - 1];
                modelOverrides.set(openid, selected);
                return `已切换到: ${selected}`;
            }
            // /m <模糊关键词> → 模糊匹配
            const keyword = args.join(" ").toLowerCase();
            const matched = allModels.find((m) => m.toLowerCase().includes(keyword));
            if (matched) {
                modelOverrides.set(openid, matched);
                return `已切换到: ${matched}`;
            }
            return `未找到模型 "${args.join(" ")}"，发送 /m 查看列表。`;
        }
        // ── /exec ───────────────────────────────────────────────────────────────
        case "exec": {
            if (args.length === 0) {
                return "用法：/x <shell命令>，例如 /x ls ~";
            }
            const cmd = args.join(" ");
            try {
                const { stdout, stderr } = await execAsync(cmd, {
                    timeout: 15_000,
                    shell: "/bin/zsh",
                });
                const out = stdout.trim();
                const err = stderr.trim();
                const result = [out, err].filter(Boolean).join("\n---stderr---\n");
                if (!result)
                    return `(命令执行完毕，无输出)`;
                // 截断超长输出
                return result.length > 2000
                    ? result.slice(0, 2000) + "\n...(输出已截断)"
                    : result;
            }
            catch (e) {
                const msg = e?.stderr?.trim() || e?.message || String(e);
                return `执行失败: ${msg.slice(0, 500)}`;
            }
        }
        // ── /status ──────────────────────────────────────────────────────────────
        case "status": {
            const currentOverride = modelOverrides.get(openid);
            const currentModel = currentOverride ?? config.routing.default;
            const uptimeSec = Math.floor((Date.now() - startedAt.getTime()) / 1000);
            const uptimeStr = uptimeSec < 60
                ? `${uptimeSec}s`
                : uptimeSec < 3600
                    ? `${Math.floor(uptimeSec / 60)}m ${uptimeSec % 60}s`
                    : `${Math.floor(uptimeSec / 3600)}h ${Math.floor((uptimeSec % 3600) / 60)}m`;
            return [
                "运行状态",
                `模型: ${currentModel}${currentOverride ? " (已覆盖)" : ""}`,
                `记忆策略: ${config.memory.strategy}`,
                `运行时长: ${uptimeStr}`,
                `端口: ${config.server.port}`,
            ].join("\n");
        }
        // ── /help ───────────────────────────────────────────────────────────────
        case "help": {
            return buildHelpText();
        }
        default:
            return null;
    }
}
