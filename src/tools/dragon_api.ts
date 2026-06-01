// @ts-nocheck
/**
 * dragon_api — 调用腾讯云 dragon-stock API
 *
 * 覆盖路由：
 *   行情  GET /api/quotes/latest, /api/quotes/:code, /api/quotes/hot
 *   K线   GET /api/kline/:code, /api/kline
 *   新闻  GET /api/news, /api/news/:id, /api/industry-news
 *   策略  GET /api/strategies/list, /api/strategies/signals/:strategy/:date
 *         GET /api/strategies/stock/:code/:strategy
 *         GET /api/strategies/stats/:code/:strategy
 *         GET /api/strategies/insight/:code
 *   资金  GET /api/capital-flow/:code, /api/capital-flow/rank/today
 *   监控  GET /api/monitor/realtime
 *   统计  GET /api/stats, /api/stats/crawl-log
 *   数据源 GET /api/datasource/status, /api/data-assets
 *
 * 鉴权：
 *   - dragon-api token 通过 env DRAGON_API_TOKEN 注入（需要先 /api/auth/login 获取）
 *   - 已保存 token 在 ~/.gemeniclaw/dragon_api_token.txt
 */

import { get as httpsGet, request as httpsRequest } from 'node:https';
import { get as httpGet, request as httpRequest } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { registry } from './registry.js';

// dragon-api 只监听 127.0.0.1:3000，通过 SSH 在远端 curl 访问
const REMOTE_BASE = 'http://127.0.0.1:3000';
const SSH_HOST = 'tencent';
const TOKEN_FILE = join(homedir(), '.gemeniclaw', 'dragon_api_token.txt');
const DEFAULT_USER = process.env.DRAGON_API_USER || 'lipingjiang';
const DEFAULT_PASS = process.env.DRAGON_API_PASS || '';

function sshCurl(cmd: string, timeoutMs = 30000): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const proc = spawn('ssh', [SSH_HOST, cmd], { env: process.env });
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill('SIGTERM');
      reject(new Error(`SSH curl timed out after ${timeoutMs / 1000}s`));
    }, timeoutMs);

    proc.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    proc.on('close', (code) => {
      if (timedOut) return;
      clearTimeout(timer);
      // curl with -w outputs status at the end; we embed status in body
      resolve({ status: code === 0 ? 200 : 500, body: stdout || stderr });
    });
    proc.on('error', (err) => {
      if (timedOut) return;
      clearTimeout(timer);
      reject(err);
    });
  });
}

function getToken(): string {
  if (process.env.DRAGON_API_TOKEN) return process.env.DRAGON_API_TOKEN;
  if (existsSync(TOKEN_FILE)) {
    return readFileSync(TOKEN_FILE, 'utf8').trim();
  }
  return '';
}

async function ensureToken(): Promise<string> {
  const existing = getToken();
  if (existing) return existing;
  if (!DEFAULT_PASS) throw new Error('无可用 token，且未配置 DRAGON_API_PASS。请先执行 dragon_api action=login');
  // 自动登录
  const escaped = DEFAULT_PASS.replace(/'/g, "'\\''")
  const cmd = `curl -s -X POST '${REMOTE_BASE}/api/auth/login' -H 'Content-Type: application/json' -d '${JSON.stringify({ username: DEFAULT_USER, password: DEFAULT_PASS })}'`;
  const res = await sshCurl(cmd, 20000);
  const data = JSON.parse(res.body);
  if (!data.token) throw new Error(`登录失败: ${res.body}`);
  const { writeFileSync } = await import('node:fs');
  writeFileSync(TOKEN_FILE, data.token, 'utf8');
  return data.token;
}

async function apiGet(path: string, token: string): Promise<any> {
  // 需要转义路径中的单引号
  const safePath = path.replace(/'/g, "'\\''")
  const cmd = `curl -s -H 'Authorization: Bearer ${token}' '${REMOTE_BASE}${safePath}'`;
  const res = await sshCurl(cmd, 20000);
  if (res.body.includes('"error":"Unauthorized"') || res.body.includes('"error":"Invalid token"')) {
    throw new Error('Token 已过期，请重新登录（action=login）');
  }
  try { return JSON.parse(res.body); } catch { return res.body; }
}

// ─── Handler ──────────────────────────────────────────────────────────────────

async function dragonApiHandler(params: any, _ctx: any) {
  const { action, code, strategy, date, days, limit, category, industry, format } = params;

  try {
    // 登录动作不需要 token
    if (action === 'login') {
      const user = params.username || DEFAULT_USER;
      const pass = params.password || DEFAULT_PASS;
      if (!pass) return { type: 'error', error: '需要提供 password 参数' };
      const body = JSON.stringify({ username: user, password: pass }).replace(/'/g, "'\\'\''");
      const cmd = `curl -s -X POST '${REMOTE_BASE}/api/auth/login' -H 'Content-Type: application/json' -d '${body}'`;
      const res = await sshCurl(cmd, 20000);
      const data = JSON.parse(res.body);
      if (data.token) {
        const { writeFileSync } = await import('node:fs');
        writeFileSync(TOKEN_FILE, data.token, 'utf8');
        return { type: 'text', text: `登录成功，token 已保存到 ${TOKEN_FILE}` };
      }
      return { type: 'error', error: `登录失败: ${res.body}` };
    }

    const token = await ensureToken();

    let result: any;

    switch (action) {
      // ── 行情 ──
      case 'quotes_latest':
        result = await apiGet('/api/quotes/latest', token);
        break;
      case 'quotes_hot':
        result = await apiGet('/api/quotes/hot', token);
        break;
      case 'quote':
        if (!code) return { type: 'error', error: '需要 code 参数' };
        result = await apiGet(`/api/quotes/${code}`, token);
        break;

      // ── K线 ──
      case 'kline': {
        if (!code) return { type: 'error', error: '需要 code 参数' };
        const qs = new URLSearchParams();
        if (days) qs.set('days', String(days));
        if (limit) qs.set('limit', String(limit));
        result = await apiGet(`/api/kline/${code}?${qs}`, token);
        break;
      }
      case 'kline_batch': {
        const qs = new URLSearchParams();
        if (code) qs.set('codes', code);
        if (days) qs.set('days', String(days));
        result = await apiGet(`/api/kline?${qs}`, token);
        break;
      }

      // ── 新闻 ──
      case 'news': {
        const qs = new URLSearchParams();
        if (code) qs.set('code', code);
        if (category) qs.set('category', category);
        if (days) qs.set('days', String(days));
        if (limit) qs.set('limit', String(limit));
        result = await apiGet(`/api/news?${qs}`, token);
        break;
      }
      case 'industry_news': {
        const qs = new URLSearchParams();
        if (industry) qs.set('industry', industry);
        if (limit) qs.set('limit', String(limit));
        result = await apiGet(`/api/industry-news?${qs}`, token);
        break;
      }

      // ── 策略信号 ──
      case 'strategies_list':
        result = await apiGet('/api/strategies/list', token);
        break;
      case 'strategy_signals': {
        if (!strategy || !date) return { type: 'error', error: '需要 strategy 和 date 参数' };
        result = await apiGet(`/api/strategies/signals/${strategy}/${date}`, token);
        break;
      }
      case 'strategy_stock': {
        if (!code || !strategy) return { type: 'error', error: '需要 code 和 strategy 参数' };
        result = await apiGet(`/api/strategies/stock/${code}/${strategy}`, token);
        break;
      }
      case 'strategy_stats': {
        if (!code || !strategy) return { type: 'error', error: '需要 code 和 strategy 参数' };
        result = await apiGet(`/api/strategies/stats/${code}/${strategy}`, token);
        break;
      }
      case 'strategy_insight': {
        if (!code) return { type: 'error', error: '需要 code 参数' };
        result = await apiGet(`/api/strategies/insight/${code}`, token);
        break;
      }

      // ── 资金流向 ──
      case 'capital_flow': {
        if (!code) return { type: 'error', error: '需要 code 参数' };
        result = await apiGet(`/api/capital-flow/${code}`, token);
        break;
      }
      case 'capital_flow_rank':
        result = await apiGet('/api/capital-flow/rank/today', token);
        break;

      // ── 监控 / 统计 ──
      case 'monitor_realtime':
        result = await apiGet('/api/monitor/realtime', token);
        break;
      case 'stats':
        result = await apiGet('/api/stats', token);
        break;
      case 'stats_summary':
        result = await apiGet('/api/stats/summary', token);
        break;
      case 'crawl_log': {
        const qs = new URLSearchParams();
        if (days) qs.set('days', String(days));
        if (limit) qs.set('limit', String(limit));
        result = await apiGet(`/api/stats/crawl-log?${qs}`, token);
        break;
      }

      // ── 数据源状态 ──
      case 'datasource_status':
        result = await apiGet('/api/datasource/status', token);
        break;
      case 'data_assets':
        result = await apiGet('/api/data-assets', token);
        break;

      default:
        return { type: 'error', error: `未知 action: ${action}。可用：login, quote, quotes_latest, quotes_hot, kline, kline_batch, news, industry_news, strategies_list, strategy_signals, strategy_stock, strategy_stats, strategy_insight, capital_flow, capital_flow_rank, monitor_realtime, stats, stats_summary, crawl_log, datasource_status, data_assets` };
    }

    const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
    const maxChars = 12000;
    return { type: 'text', text: text.length > maxChars ? text.slice(0, maxChars) + '\n...[truncated]' : text };

  } catch (err: any) {
    return { type: 'error', error: err.message };
  }
}

registry.register({
  name: 'dragon_api',
  description: '调用腾讯云 dragon-stock API。查询 A股/港股/美股行情、K线、新闻、策略信号、资金流向、数据源状态等。action 参数指定操作类型。',
  schema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        description: '操作类型：login | quote | quotes_latest | quotes_hot | kline | kline_batch | news | industry_news | strategies_list | strategy_signals | strategy_stock | strategy_stats | strategy_insight | capital_flow | capital_flow_rank | monitor_realtime | stats | stats_summary | crawl_log | datasource_status | data_assets',
      },
      code: { type: 'string', description: '股票代码，如 sh600519、hk00700、AAPL' },
      strategy: { type: 'string', description: '策略名称，如 v29、us-v23' },
      date: { type: 'string', description: '日期，格式 YYYY-MM-DD' },
      days: { type: 'number', description: '查询最近 N 天（默认 7）' },
      limit: { type: 'number', description: '返回条数上限（默认 50）' },
      category: { type: 'string', description: '新闻分类' },
      industry: { type: 'string', description: '行业名称（industry_news 用）' },
      username: { type: 'string', description: '登录用户名（login 时用）' },
      password: { type: 'string', description: '登录密码（login 时用）' },
    },
    required: ['action'],
  },
  handler: dragonApiHandler,
  toolset: ['default'],
  requiresApproval: false,
  executionMode: 'parallel',
});
