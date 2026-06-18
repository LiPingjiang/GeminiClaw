// @ts-nocheck
/**
 * db_query — 查询/写入本地 DuckDB 数据库
 *
 * 通过本地 duckdb-gateway（127.0.0.1:3100）直接 HTTP 调用，无需 SSH。
 *
 * 支持模式：
 *   read     — 执行只读 SQL 查询（默认）
 *   write    — 执行写入 SQL（INSERT/UPDATE/DELETE/CREATE）
 *   tables   — 列出所有表
 *   schema   — 查看某张表的结构（传表名到 sql 参数）
 *   social   — 读取本地 social-intel 数据文件（JSON/DuckDB）
 *
 * 数据库位置：~/Codes/ai/dragon-stock/data/stock_monitor.duckdb
 * Gateway 端点：http://127.0.0.1:3100
 *
 * 常用查询示例：
 *   - SELECT * FROM signal_tracker ORDER BY signal_date DESC LIMIT 20
 *   - SELECT * FROM sector_flow ORDER BY trade_date DESC LIMIT 10
 *   - INSERT INTO signal_tracker (code, signal_date, ...) VALUES (...)
 */

import { readFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { registry } from './registry.js';

// ─── Audit Logger ─────────────────────────────────────────────────────────────

const AUDIT_DIR = join(process.env.HOME ?? '/tmp', '.gemeniclaw', 'audit');
try { mkdirSync(AUDIT_DIR, { recursive: true }); } catch {}

function auditLog(event: string, data: Record<string, unknown>) {
  const ts = new Date().toISOString();
  const line = JSON.stringify({ ts, event, ...data }) + '\n';
  try {
    appendFileSync(join(AUDIT_DIR, 'db_query.jsonl'), line, 'utf-8');
  } catch {}
  console.log(`[AUDIT:db_query] ${event} ${JSON.stringify(data)}`);
}

// ─── Config ──────────────────────────────────────────────────────────────────

const GATEWAY_URL = process.env.DUCKDB_GATEWAY_URL ?? 'http://127.0.0.1:3100';
const SOCIAL_DATA = process.env.DRAGON_SOCIAL_DATA
  ?? `${process.env.HOME}/Codes/ai/dragon-stock/social-intel/data`;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function truncate(text: string, maxLen = 12000): string {
  if (text.length <= maxLen) return text;
  const half = Math.floor(maxLen / 2) - 20;
  return text.slice(0, half) + '\n...[truncated]...\n' + text.slice(-half);
}

// ─── Handler ─────────────────────────────────────────────────────────────────

async function dbQueryHandler(params: any, _ctx: any) {
  const { mode = 'read', sql, file, limit } = params;

  try {
    let result: string;

    if (mode === 'read' || mode === 'duckdb') {
      // 只读查询
      if (!sql) return { type: 'error', error: '需要 sql 参数' };

      const resp = await fetch(`${GATEWAY_URL}/read`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sql, format: 'json' }),
      });

      if (!resp.ok) {
        const text = await resp.text();
        return { type: 'error', error: `查询失败 (${resp.status}): ${text}` };
      }

      result = await resp.text();

    } else if (mode === 'write') {
      // 写入 SQL
      if (!sql) return { type: 'error', error: '需要 sql 参数' };

      auditLog('WRITE_START', { sql: sql.slice(0, 2000), sqlLen: sql.length });

      const resp = await fetch(`${GATEWAY_URL}/write/sql`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sql }),
      });

      if (!resp.ok) {
        const text = await resp.text();
        auditLog('WRITE_FAILED', { status: resp.status, error: text.slice(0, 500) });
        return { type: 'error', error: `写入失败 (${resp.status}): ${text}` };
      }

      result = await resp.text();
      auditLog('WRITE_OK', { sql: sql.slice(0, 500), resultPreview: result.slice(0, 200) });

    } else if (mode === 'tables') {
      // 列出所有表
      const resp = await fetch(`${GATEWAY_URL}/read`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sql: 'SHOW TABLES', format: 'json' }),
      });

      if (!resp.ok) {
        const text = await resp.text();
        return { type: 'error', error: `查询失败 (${resp.status}): ${text}` };
      }

      result = await resp.text();

    } else if (mode === 'schema') {
      // 查看表结构
      if (!sql) return { type: 'error', error: '需要在 sql 参数中传入表名' };

      const resp = await fetch(`${GATEWAY_URL}/read`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sql: `DESCRIBE ${sql}`, format: 'json' }),
      });

      if (!resp.ok) {
        const text = await resp.text();
        return { type: 'error', error: `查询失败 (${resp.status}): ${text}` };
      }

      result = await resp.text();

    } else if (mode === 'social') {
      // 读取 social-intel 数据
      if (file) {
        // 读取指定文件
        const safeName = file.replace(/[^a-zA-Z0-9_\-.]/g, '');
        const filePath = `${SOCIAL_DATA}/${safeName}`;
        try {
          const content = readFileSync(filePath, 'utf-8');
          if (limit && safeName.endsWith('.json')) {
            const parsed = JSON.parse(content);
            const sliced = Array.isArray(parsed) ? parsed.slice(0, limit) : parsed;
            result = JSON.stringify(sliced, null, 2);
          } else {
            result = content;
          }
        } catch (err: any) {
          return { type: 'error', error: `读取文件失败: ${err.message}` };
        }
      } else if (sql) {
        // 对本地 social DuckDB 执行查询（通过 gateway）
        const resp = await fetch(`${GATEWAY_URL}/read`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sql, format: 'json' }),
        });

        if (!resp.ok) {
          const text = await resp.text();
          return { type: 'error', error: `查询失败 (${resp.status}): ${text}` };
        }

        result = await resp.text();
      } else {
        // 列出 social-intel 数据目录
        try {
          const files = readdirSync(SOCIAL_DATA);
          result = files.join('\n');
        } catch (err: any) {
          return { type: 'error', error: `读取目录失败: ${err.message}` };
        }
      }

    } else {
      return { type: 'error', error: `未知 mode: ${mode}。可用：read | write | tables | schema | social` };
    }

    return { type: 'text', text: truncate(result.trim()) };

  } catch (err: any) {
    return { type: 'error', error: err.message };
  }
}

// ─── Register ────────────────────────────────────────────────────────────────

registry.register({
  name: 'db_query',
  description:
    '查询或写入本地 DuckDB 数据库（stock_monitor）。' +
    '支持 mode: read（只读查询，默认）、write（INSERT/UPDATE/DELETE）、tables（列出所有表）、schema（查看表结构）、social（读取 social-intel 数据文件）。' +
    '常用表：signal_tracker、sector_flow、daily_kline、backtest_results 等。',
  schema: {
    type: 'object',
    properties: {
      mode: {
        type: 'string',
        description: '操作模式：read（只读查询，默认）| write（写入 SQL）| tables（列出所有表）| schema（查看表结构，sql 填表名）| social（读取舆情数据文件）',
        enum: ['read', 'write', 'tables', 'schema', 'social'],
      },
      sql: {
        type: 'string',
        description: 'SQL 查询/写入语句。mode=schema 时填表名。',
      },
      file: {
        type: 'string',
        description: '文件名（mode=social 时，如 hot_search_latest.json）',
      },
      limit: {
        type: 'number',
        description: '返回行数上限（social 模式的 JSON 列表截断，默认不限）',
      },
    },
    required: [],
  },
  handler: dbQueryHandler,
  toolset: ['default'],
  requiresApproval: false,
  executionMode: 'sequential',
});
