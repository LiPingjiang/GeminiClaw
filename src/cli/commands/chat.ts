// @ts-nocheck
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import os from "os";
import yaml from "js-yaml";
import { printError } from "../lib/output.js";
function loadServerConfig() {
    // 查找顺序：~/.gemeniclaw/config.yaml → cwd/config.yaml
    const userCfg = join(os.homedir(), '.gemeniclaw', 'config.yaml');
    const cwdCfg = join(process.cwd(), 'config.yaml');
    const cfgPath = existsSync(userCfg) ? userCfg : existsSync(cwdCfg) ? cwdCfg : null;
    let port = 18888;
    let host = '127.0.0.1';
    let authToken;
    if (cfgPath) {
        try {
            const raw = yaml.load(readFileSync(cfgPath, 'utf-8'));
            port = raw?.server?.port ?? port;
            host = raw?.server?.host ?? host;
            authToken = raw?.server?.authToken;
        }
        catch { }
    }
    // 环境变量优先
    if (process.env.GC_SERVER_URL) {
        return { baseUrl: process.env.GC_SERVER_URL, authToken: process.env.GC_AUTH_TOKEN ?? authToken };
    }
    return { baseUrl: `http://${host}:${port}`, authToken };
}
async function apiFetch(url, opts) {
    const headers = { 'Content-Type': 'application/json' };
    if (opts.authToken)
        headers['Authorization'] = `Bearer ${opts.authToken}`;
    const res = await fetch(url, {
        method: opts.method ?? 'GET',
        headers,
        body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status}: ${text}`);
    }
    return res.json();
}
export function registerChatCommand(program) {
    // ── gc chat ─────────────────────────────────────────────────────────────────
    program
        .command("chat [message]")
        .description(`Chat with GeminiClaw agent

USAGE
  gc chat "你好"                      # 新 session，一次性对话
  gc chat --session <id> "继续聊"     # 续接已有 session
  gc chat --session <id>             # 从 stdin 读消息
  gc chat --new "开始新话题"          # 明确创建新 session

OPTIONS
  --session, -s <id>   指定 session id（不指定则新建）
  --model, -m <name>   指定模型（覆盖默认配置）
  --json               输出完整 JSON 响应

AGENT INTEROP
  其他 Agent 调用示例（shell）：
    gc chat --session \$SESSION_ID "\$MESSAGE"
    gc chat --json "问题" | jq -r .response`)
        .option("-s, --session <id>", "Session ID（续接已有会话）")
        .option("-a, --agent <id>", "Agent ID（指定 agent 身份）")
        .option("-m, --model <name>", "模型名称")
        .option("--new", "强制新建 session")
        .option("--json", "输出完整 JSON")
        .action(async (message, opts) => {
        const format = opts.json ? "json" : "human";
        try {
            const srv = loadServerConfig();
            // 消息来源：参数 > stdin
            let msg = message;
            if (!msg) {
                const chunks = [];
                for await (const chunk of process.stdin)
                    chunks.push(chunk);
                msg = chunks.join('').trim();
            }
            if (!msg) {
                printError("请提供消息内容（参数或 stdin）", format);
                process.exit(1);
            }
            const sessionId = opts.new ? undefined : opts.session;
            const body = { message: msg };
            if (sessionId)
                body.sessionId = sessionId;
            if (opts.agent)
                body.agentId = opts.agent;
            if (opts.model)
                body.model = opts.model;
            const data = await apiFetch(`${srv.baseUrl}/v1/agent/chat`, {
                method: 'POST',
                body,
                authToken: srv.authToken,
            });
            if (format === "json") {
                console.log(JSON.stringify(data, null, 2));
            }
            else {
                console.log(data.response);
                console.error(`[session: ${data.sessionId} | turns: ${data.totalTurns}]`);
            }
        }
        catch (e) {
            printError(String(e), format);
            process.exit(1);
        }
    });
    // ── gc session ───────────────────────────────────────────────────────────────
    const sessionCmd = program
        .command("session")
        .description("Session 管理（列表、历史查看）");
    sessionCmd
        .command("list")
        .description("列出所有 session")
        .option("--limit <n>", "最多显示条数", "20")
        .option("--json", "输出 JSON")
        .action(async (opts) => {
        const format = opts.json ? "json" : "human";
        try {
            const srv = loadServerConfig();
            const data = await apiFetch(`${srv.baseUrl}/v1/sessions?limit=${opts.limit}`, { authToken: srv.authToken });
            if (format === "json") {
                console.log(JSON.stringify(data, null, 2));
            }
            else {
                if (data.sessions.length === 0) {
                    console.log("暂无 session");
                    return;
                }
                for (const s of data.sessions) {
                    const title = s.title ?? s.id;
                    console.log(`${s.id}  [${s.message_count} 条]  ${s.updated_at.slice(0, 16)}  ${title !== s.id ? title : ''}`);
                }
            }
        }
        catch (e) {
            printError(String(e), format);
            process.exit(1);
        }
    });
    sessionCmd
        .command("show <id>")
        .description("查看某个 session 的完整对话历史")
        .option("--limit <n>", "最多显示消息数", "200")
        .option("--json", "输出 JSON")
        .action(async (id, opts) => {
        const format = opts.json ? "json" : "human";
        try {
            const srv = loadServerConfig();
            const data = await apiFetch(`${srv.baseUrl}/v1/sessions/${id}/messages?limit=${opts.limit}`, { authToken: srv.authToken });
            if (format === "json") {
                console.log(JSON.stringify(data, null, 2));
            }
            else {
                console.log(`── Session: ${data.session_id} (${data.messages.length} 条) ──\n`);
                for (const m of data.messages) {
                    const prefix = m.role === 'user' ? '👤 User' : m.role === 'assistant' ? '🤖 Assistant' : '⚙️  System';
                    const time = m.created_at.slice(0, 16);
                    console.log(`[${time}] ${prefix}:`);
                    console.log(m.content);
                    console.log();
                }
            }
        }
        catch (e) {
            printError(String(e), format);
            process.exit(1);
        }
    });
}
