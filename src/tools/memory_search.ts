// @ts-nocheck
// src/tools/memory_search.ts
// Tool: keyword search across all memory sources for any agent.
import { registry } from "./registry.js";
import { readdirSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import os from "os";

interface Hit {
  source: string;
  location: string;
  snippet: string;
}

function scanFile(
  path: string,
  query: string,
  source: string,
  location: string,
  hits: Hit[],
): void {
  if (!existsSync(path)) return;
  let content: string;
  try {
    content = readFileSync(path, "utf-8");
  } catch {
    return;
  }
  const idx = content.indexOf(query);
  if (idx === -1) return;
  const start = Math.max(0, idx - 40);
  const end = Math.min(content.length, idx + query.length + 80);
  hits.push({
    source,
    location,
    snippet: content.slice(start, end).replace(/\n+/g, " "),
  });
}

function scanDir(dir: string, query: string, source: string, hits: Hit[]): void {
  if (!existsSync(dir)) return;
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".md"));
  } catch {
    return;
  }
  for (const f of files)
    scanFile(join(dir, f), query, source, f.replace(/\.md$/, ""), hits);
}

registry.register({
  name: "memory_search",
  description:
    '按关键词搜索记忆，覆盖全局日记、当前助手私人记忆、公共知识库以及全部历史会话(chat_messages)。当用户说"搜索记忆""之前聊过""找一下历史记录"时调用。',
  schema: {
    type: "object",
    properties: {
      query: { type: "string", description: "要搜索的关键词" },
    },
    required: ["query"],
  },
  handler: async (params, ctx) => {
    const query = String(params.query || "").trim();
    if (!query) return { type: "error", error: "memory_search: query 不能为空" };
    const root =
      (ctx.extra?.memoryRoot as string) || join(os.homedir(), ".gemeniclaw");
    const targetAgentId = ctx.extra?.targetAgentId as string | undefined;
    const db = ctx.extra?.db;
    const hits: Hit[] = [];

    // 1. global daily + global MEMORY.md
    scanDir(join(root, "memory", "global", "daily"), query, "全局日记", hits);
    scanFile(
      join(root, "memory", "global", "MEMORY.md"),
      query,
      "全局长期记忆",
      "MEMORY.md",
      hits,
    );

    // 2. per-agent private memory
    if (targetAgentId) {
      scanFile(
        join(root, "agents", targetAgentId, "MEMORY.md"),
        query,
        "私人长期记忆",
        "MEMORY.md",
        hits,
      );
      scanDir(
        join(root, "agents", targetAgentId, "daily"),
        query,
        "私人日记",
        hits,
      );
    }

    // 3. public_knowledge (DB)
    if (db) {
      try {
        const rows = db
          .prepare(
            `SELECT id, title, summary FROM public_knowledge WHERE active = 1 AND (title LIKE ? OR summary LIKE ?) LIMIT 10`,
          )
          .all(`%${query}%`, `%${query}%`) as Array<{
          id: string;
          title: string;
          summary: string | null;
        }>;
        for (const r of rows)
          hits.push({
            source: "公共知识库",
            location: r.id,
            snippet: `${r.title}: ${(r.summary || "").slice(0, 80)}`,
          });
      } catch {
        /* table may not exist */
      }
    }

    // 4. chat_messages history (all sessions)
    if (db) {
      try {
        const rows = db
          .prepare(
            `SELECT a.agent_name AS agent_name, m.role AS role,
                    substr(m.content, 1, 120) AS snippet, m.created_at AS created_at
             FROM chat_messages m
             LEFT JOIN agents a ON a.session_id = m.session_id
             WHERE m.content LIKE ?
             ORDER BY m.created_at DESC LIMIT 15`,
          )
          .all(`%${query}%`) as Array<{
          agent_name: string | null;
          role: string;
          snippet: string;
          created_at: string;
        }>;
        for (const r of rows)
          hits.push({
            source: "历史会话",
            location: `${r.agent_name || "?"} ${r.created_at} (${r.role})`,
            snippet: r.snippet.replace(/\n+/g, " "),
          });
      } catch {
        /* table may not exist */
      }
    }

    if (hits.length === 0)
      return { type: "text", text: `未找到与「${query}」相关的记忆。` };

    const grouped: Record<string, Hit[]> = {};
    for (const h of hits) (grouped[h.source] ||= []).push(h);
    const out: string[] = [`# 搜索「${query}」共 ${hits.length} 条命中\n`];
    for (const [src, list] of Object.entries(grouped)) {
      out.push(`## ${src}（${list.length}）`);
      for (const h of list) out.push(`- [${h.location}] ${h.snippet}`);
    }
    return { type: "text", text: out.join("\n") };
  },
});
