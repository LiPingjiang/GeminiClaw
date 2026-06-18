// @ts-nocheck
/**
 * sandbox_exec — 在远程 E2B Sandbox 中执行代码
 *
 * 工作流：
 *   1. Agent 调用此工具，提交代码到腾讯云任务队列
 *   2. 本地 Mac worker 从队列拉取任务，在 E2B Sandbox 中执行
 *   3. 本工具轮询任务状态，直到完成或超时
 *
 * 架构：
 *   GeminiClaw (本工具) → 腾讯云 queue-server:3200 ← 本地 Mac worker → E2B Sandbox
 *
 * 适用场景：
 *   - 执行不受信任的代码（沙箱隔离）
 *   - 运行需要特定环境的 Python/Bash 脚本
 *   - 长时间运行的计算任务（最长 10 分钟）
 *   - 需要网络访问的代码（沙箱有外网）
 */

import { registry } from './registry.js';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

// ─── Audit Logger ─────────────────────────────────────────────────────────────

const AUDIT_DIR = join(process.env.HOME ?? '/tmp', '.gemeniclaw', 'audit');
try { mkdirSync(AUDIT_DIR, { recursive: true }); } catch {}

function auditLog(event: string, data: Record<string, unknown>) {
  const ts = new Date().toISOString();
  const line = JSON.stringify({ ts, event, ...data }) + '\n';
  try {
    appendFileSync(join(AUDIT_DIR, 'sandbox_exec.jsonl'), line, 'utf-8');
  } catch {}
  console.log(`[AUDIT:sandbox_exec] ${event} ${JSON.stringify(data)}`);
}

// ─── Config ──────────────────────────────────────────────────────────────────

const QUEUE_URL = process.env.SANDBOX_QUEUE_URL ?? 'http://127.0.0.1:3200';
const AUTH_TOKEN = 'gc-sandbox-2026';
const DEFAULT_TIMEOUT = 300; // 5 minutes
const POLL_INTERVAL_MS = 2000; // 2 seconds between polls
const MAX_POLL_TIME_MS = 10 * 60 * 1000; // 10 minutes max wait

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function submitTask(input: {
  code: string;
  language: string;
  timeout: number;
  key_preference: string;
  require_backtest_template?: boolean;
  require_15yr_template?: boolean;
}): Promise<{ taskId: string }> {
  const res = await fetch(`${QUEUE_URL}/tasks`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${AUTH_TOKEN}`,
    },
    body: JSON.stringify(input),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Queue submit failed (${res.status}): ${text}`);
  }

  return res.json();
}

async function pollTask(taskId: string): Promise<{
  status: string;
  result?: { stdout: string; stderr: string; exitCode: number };
  error?: string;
}> {
  const res = await fetch(`${QUEUE_URL}/tasks/${taskId}`, {
    headers: { 'Authorization': `Bearer ${AUTH_TOKEN}` },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Queue poll failed (${res.status}): ${text}`);
  }

  return res.json();
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function truncate(text: string, maxLen = 8000): string {
  if (text.length <= maxLen) return text;
  const half = Math.floor(maxLen / 2) - 20;
  return text.slice(0, half) + '\n...[truncated]...\n' + text.slice(-half);
}

// ─── Handler ─────────────────────────────────────────────────────────────────

async function sandboxExecHandler(params: any, _ctx: any) {
  const code: string = params.code;
  const language: string = params.language ?? 'python';
  const timeout: number = params.timeout ?? DEFAULT_TIMEOUT;
  const keyPreference: string = params.key_preference ?? 'any';
  const requireBacktestTemplate: boolean = params.require_backtest_template ?? false;
  const require15yrTemplate: boolean = params.require_15yr_template ?? false;

  if (!code || !code.trim()) {
    return { type: 'error', error: '需要提供 code 参数' };
  }

  const codeHash = createHash('sha256').update(code).digest('hex').slice(0, 16);
  const codePreview = code.slice(0, 200).replace(/\n/g, '⏎');
  auditLog('SUBMIT', { codeHash, codeLen: code.length, codePreview, language, timeout, keyPreference, requireBacktestTemplate, require15yrTemplate });

  // 1. Submit task to queue
  let taskId: string;
  try {
    const resp = await submitTask({ code, language, timeout, key_preference: keyPreference, require_backtest_template: requireBacktestTemplate, require_15yr_template: require15yrTemplate });
    taskId = resp.taskId;
    auditLog('SUBMITTED', { taskId, codeHash });
  } catch (err: any) {
    auditLog('SUBMIT_FAILED', { codeHash, error: err.message });
    return { type: 'error', error: `提交任务失败: ${err.message}` };
  }

  // 2. Poll for result
  const startTime = Date.now();
  const maxWait = Math.min(timeout * 1000 + 30000, MAX_POLL_TIME_MS); // task timeout + 30s buffer

  while (Date.now() - startTime < maxWait) {
    await sleep(POLL_INTERVAL_MS);

    try {
      const task = await pollTask(taskId);

      if (task.status === 'completed' && task.result) {
        const { stdout, stderr, exitCode } = task.result;
        const rawStdoutLen = (stdout || '').length;
        const rawStderrLen = (stderr || '').length;
        let output = stdout || '';
        if (stderr) output += (output ? '\n' : '') + `STDERR:\n${stderr}`;

        auditLog('COMPLETED', {
          taskId,
          codeHash,
          exitCode,
          stdoutLen: rawStdoutLen,
          stderrLen: rawStderrLen,
          stdoutPreview: (stdout || '').slice(0, 500),
          durationMs: Date.now() - startTime,
        });

        output = truncate(output);

        if (exitCode !== 0) {
          return {
            type: 'text',
            text: `[Sandbox ${language}] Exit code ${exitCode}\n${output}`,
          };
        }
        return {
          type: 'text',
          text: `[Sandbox ${language}] ✓\n${output}`,
        };
      }

      if (task.status === 'failed') {
        auditLog('FAILED', { taskId, codeHash, error: task.error });
        return {
          type: 'error',
          error: `Sandbox 执行失败: ${task.error || 'unknown error'}`,
        };
      }

      // Still pending or running — continue polling
    } catch (err: any) {
      auditLog('POLL_ERROR', { taskId, codeHash, error: err.message, elapsedMs: Date.now() - startTime });
      if (Date.now() - startTime > maxWait - 5000) {
        return { type: 'error', error: `轮询超时，最后错误: ${err.message}` };
      }
    }
  }

  auditLog('TIMEOUT', { taskId, codeHash, maxWaitMs: maxWait });
  return {
    type: 'error',
    error: `任务超时 (${Math.round(maxWait / 1000)}s)。taskId: ${taskId}，可稍后手动查询。`,
  };
}

// ─── Register ────────────────────────────────────────────────────────────────

registry.register({
  name: 'sandbox_exec',
  description: '在远程 E2B Sandbox 中执行 Python 或 Bash 代码。代码在隔离沙箱中运行，有完整的网络访问和文件系统。适合：运行不受信任的代码、需要特定依赖的脚本、长时间计算任务。沙箱有 Python 3.12 + 常用库（duckdb/numpy/pandas/scipy/matplotlib/requests 等）。',
  schema: {
    type: 'object',
    properties: {
      code: {
        type: 'string',
        description: '要执行的代码（Python 或 Bash 脚本）',
      },
      language: {
        type: 'string',
        description: '语言：python（默认）或 bash',
        enum: ['python', 'bash'],
      },
      timeout: {
        type: 'number',
        description: '执行超时秒数（默认 300，最大 600）',
      },
      key_preference: {
        type: 'string',
        description: '指定使用哪个 Sandbox key（key1/key2/key3/any），默认 any（自动选择负载最低的）',
        enum: ['key1', 'key2', 'key3', 'any'],
      },
      require_backtest_template: {
        type: 'boolean',
        description: '是否要求使用 3 年回测模板。模板预装 /data/kline_3yr.parquet（660万行3年K线，字段: code/market/date/open/high/low/close/volume/turnover）。必须用 duckdb 读取。',
      },
      require_15yr_template: {
        type: 'boolean',
        description: '是否要求使用 15 年回测模板。模板预装 /data/kline_15yr.parquet（1821万行15年K线，10569只股票，2011~2026，市场: HK/SZ/SH/US/INDEX，字段: code/market/date/open/high/low/close/volume/turnover）+ /data/kline_3yr.parquet。必须用 duckdb 读取。',
      },
    },
    required: ['code'],
  },
  handler: sandboxExecHandler,
  toolset: ['default'],
  requiresApproval: true,
  executionMode: 'sequential',
});
