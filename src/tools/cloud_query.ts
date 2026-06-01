// @ts-nocheck
/**
 * cloud_query — SSH 到腾讯云执行数据库查询
 *
 * 支持两种数据库：
 *   duckdb   — /opt/dragon-stock/data/stock_monitor.duckdb（主力数据）
 *              通过 duckdb-gateway POST /read 接口（127.0.0.1:3100）
 *   sqlite   — /opt/dragon-stock/stock_monitor.db（历史数据）
 *              通过 SSH + sqlite3 命令
 *   social   — /opt/dragon-stock/social-intel/data/（热搜/舆情 DuckDB/SQLite）
 *              通过 SSH + duckdb/sqlite3 命令
 *
 * 本工具通过 SSH 在远端执行命令，底层复用 exec 工具的 SSH 能力。
 *
 * 常用查询示例：
 *   - 查最近策略信号：SELECT * FROM signal_tracker ORDER BY signal_date DESC LIMIT 20
 *   - 查板块资金流：SELECT * FROM sector_flow ORDER BY trade_date DESC LIMIT 10
 *   - 查 social-intel 热搜：读取 hot_search_latest.json
 */

import { spawn } from 'node:child_process';
import { registry } from './registry.js';

const SSH_HOST = 'tencent';
const DUCKDB_GATEWAY = 'http://127.0.0.1:3100';
const DUCKDB_PATH = '/opt/dragon-stock/data/stock_monitor.duckdb';
const SQLITE_PATH = '/opt/dragon-stock/stock_monitor.db';
const SOCIAL_DATA = '/opt/dragon-stock/social-intel/data';

function sshExec(cmd: string, timeoutMs = 30000): Promise<string> {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const proc = spawn('ssh', [SSH_HOST, cmd], {
      env: process.env,
    });

    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill('SIGTERM');
      reject(new Error(`SSH command timed out after ${timeoutMs / 1000}s`));
    }, timeoutMs);

    proc.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

    proc.on('close', (code) => {
      if (timedOut) return;
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`Exit ${code}: ${stderr || stdout}`));
      else resolve(stdout);
    });

    proc.on('error', (err) => {
      if (timedOut) return;
      clearTimeout(timer);
      reject(err);
    });
  });
}

async function cloudQueryHandler(params: any, _ctx: any) {
  const { db = 'duckdb', sql, file, limit } = params;

  try {
    let result: string;

    if (db === 'duckdb') {
      // 通过 duckdb-gateway 执行（远端 HTTP，需 SSH 转发）
      // 实际通过 SSH 在远端 curl 调用 gateway
      if (!sql) return { type: 'error', error: '需要 sql 参数' };

      const escaped = sql.replace(/'/g, "'\\''");
      const cmd = `curl -s -X POST '${DUCKDB_GATEWAY}/read' ` +
        `-H 'Content-Type: application/json' ` +
        `-d '{"sql": "${escaped}", "format": "json"}' 2>&1`;

      result = await sshExec(cmd, 60000);

    } else if (db === 'sqlite') {
      // 通过 SSH + sqlite3 直接查询
      if (!sql) return { type: 'error', error: '需要 sql 参数' };

      const escaped = sql.replace(/'/g, "'\\''").replace(/"/g, '\\"');
      // 使用 -json 模式输出
      const cmd = `sqlite3 -json '${SQLITE_PATH}' "${escaped}" 2>&1`;
      result = await sshExec(cmd, 60000);

    } else if (db === 'social') {
      // 读取 social-intel 数据文件
      if (file) {
        // 读取指定 JSON 文件
        const safeName = file.replace(/[^a-zA-Z0-9_\-.]/g, '');
        const cmd = limit
          ? `python3 -c "import json; d=json.load(open('${SOCIAL_DATA}/${safeName}')); print(json.dumps(d if not isinstance(d,list) else d[:${limit}], ensure_ascii=False, indent=2))" 2>&1`
          : `cat '${SOCIAL_DATA}/${safeName}' 2>&1`;
        result = await sshExec(cmd, 30000);
      } else if (sql) {
        // 对 popularity.duckdb 或 finance.duckdb 执行 SQL
        const dbFile = sql.toLowerCase().includes('finance') ? 'finance.duckdb' : 'popularity.duckdb';
        const escaped = sql.replace(/'/g, "'\\''");
        const cmd = `python3 -c "
import duckdb, json, sys
con = duckdb.connect('${SOCIAL_DATA}/${dbFile}', read_only=True)
rows = con.execute('''${escaped}''').fetchdf().to_dict('records')
print(json.dumps(rows[:${limit || 100}], ensure_ascii=False, default=str))
con.close()
" 2>&1`;
        result = await sshExec(cmd, 60000);
      } else {
        // 列出 social-intel 数据文件
        result = await sshExec(`ls -lh '${SOCIAL_DATA}'/ 2>&1`);
      }

    } else if (db === 'tables') {
      // 列出 DuckDB 中所有表
      const cmd = `curl -s -X POST '${DUCKDB_GATEWAY}/read' ` +
        `-H 'Content-Type: application/json' ` +
        `-d '{"sql": "SHOW TABLES", "format": "json"}' 2>&1`;
      result = await sshExec(cmd, 30000);

    } else if (db === 'schema') {
      // 查看某张表的结构
      if (!sql) return { type: 'error', error: '需要在 sql 参数中传入表名' };
      const escaped = `DESCRIBE ${sql}`.replace(/'/g, "'\\''");
      const cmd = `curl -s -X POST '${DUCKDB_GATEWAY}/read' ` +
        `-H 'Content-Type: application/json' ` +
        `-d '{"sql": "${escaped}", "format": "json"}' 2>&1`;
      result = await sshExec(cmd, 30000);

    } else {
      return { type: 'error', error: `未知 db 类型: ${db}。可用：duckdb | sqlite | social | tables | schema` };
    }

    const maxChars = 12000;
    const text = result.trim();
    return { type: 'text', text: text.length > maxChars ? text.slice(0, maxChars) + '\n...[truncated]' : text };

  } catch (err: any) {
    return { type: 'error', error: err.message };
  }
}

registry.register({
  name: 'cloud_query',
  description: 'SSH 到腾讯云执行数据库查询。支持 DuckDB（主力数据）、SQLite（历史数据）、social-intel（热搜舆情）三种数据源。可查询 signal_tracker、sector_flow、daily_kline 等表，也可读取热搜 JSON 文件。',
  schema: {
    type: 'object',
    properties: {
      db: {
        type: 'string',
        description: '数据库类型：duckdb（默认，主力数据）| sqlite（历史数据）| social（热搜舆情）| tables（列出所有表）| schema（查看表结构）',
      },
      sql: {
        type: 'string',
        description: 'SQL 查询语句（db=duckdb/sqlite/social 时）；db=schema 时填表名',
      },
      file: {
        type: 'string',
        description: '文件名（db=social 时，如 hot_search_latest.json、popularity.duckdb）',
      },
      limit: {
        type: 'number',
        description: '返回行数上限（social 模式下的 list 截断，默认 100）',
      },
    },
    required: [],
  },
  handler: cloudQueryHandler,
  toolset: ['default'],
  requiresApproval: true,
  executionMode: 'sequential',
});
