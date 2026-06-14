/**
 * sandbox-proxy worker
 *
 * 在本地 Mac 上运行（本机可访问 E2B Sandbox API：api.sandbox.sankuai.com）。
 * 轮询腾讯云服务器上的任务队列，拿到任务后在 E2B 沙箱内执行代码，
 * 再把结果回传给队列服务，然后继续轮询。
 *
 *   ┌──────────────┐   long-poll    ┌────────────────────┐
 *   │  Tencent VM  │ ◀───────────── │   本机 Worker(本文件)  │
 *   │  task queue  │ ─── task ────▶ │  E2B Sandbox 执行     │
 *   └──────────────┘   PUT result   └────────────────────┘
 *
 * 运行：
 *   tsx src/sandbox/worker.ts
 *
 * 设计要点：
 *   - 3 个 API key 轮询（round-robin），每个 key 最多 5 个并发沙箱，总容量 15。
 *   - 永远不超过单 key 5 个并发；优先选择负载最小的 key。
 *   - 任务可指定 key_preference，尽量遵从（前提是该 key 仍有空位）。
 *   - 任务超时遵从 task.timeout（默认 300s）。
 *   - 收到 SIGINT/SIGTERM 时停止拉新任务，等当前任务跑完后优雅退出。
 *   - E2B SDK 若未安装，回退到基于 fetch 的直连 HTTP API。
 *   - 轮询失败自动重连（指数退避，最大 30s）。
 */

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------

const QUEUE_BASE_URL = process.env.SANDBOX_QUEUE_URL ?? 'http://49.232.173.252:3200';
const QUEUE_TOKEN = process.env.SANDBOX_QUEUE_TOKEN ?? 'gc-sandbox-2026';
const POLL_WAIT_SECONDS = 30;

const E2B_API_URL = 'https://api.sandbox.sankuai.com';
const E2B_DOMAIN = 'sandbox.sankuai.com';

/** 自定义模板（4C 8GB），仅 KEY1 有访问权限。 */
const CUSTOM_TEMPLATE_ID = 'gaqgjsh2dh4i7dqr8ts7';

/** 每个 key 的最大并发沙箱数。 */
const MAX_CONCURRENCY_PER_KEY = 5;

/** 任务默认超时（秒）。 */
const DEFAULT_TASK_TIMEOUT = 300;

interface KeySlot {
  /** key 的对外标识，例如 KEY1。 */
  readonly id: string;
  /** 真实 API key。 */
  readonly apiKey: string;
  /** 该 key 能否使用自定义模板（4C 8GB）。 */
  readonly canUseCustomTemplate: boolean;
  /** 当前活跃沙箱数。 */
  active: number;
}

const KEYS: KeySlot[] = [
  {
    id: 'KEY1',
    apiKey: 'e2b_f54df6c095be2d312993f6f2757c47faad67fb07',
    canUseCustomTemplate: true,
    active: 0,
  },
  {
    id: 'KEY2',
    apiKey: 'e2b_c41a5511810565c2e61711c2f4cbfea342d2dfeb',
    canUseCustomTemplate: false,
    active: 0,
  },
  {
    id: 'KEY3',
    apiKey: 'e2b_a92bc4c2475362c2bf6e592c623dcfe2f773ef79',
    canUseCustomTemplate: false,
    active: 0,
  },
];

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/** 队列下发的任务结构（字段尽量宽松，向前兼容）。 */
interface Task {
  /** 任务唯一 id。 */
  id: string;
  /** 要执行的代码（Python）。 */
  code?: string;
  /** 语言，默认 python。 */
  language?: string;
  /** 期望使用的 key（KEY1/KEY2/KEY3），可选。 */
  key_preference?: string;
  /** 需要 pip 安装的依赖（用于 base 模板）。 */
  pip?: string[];
  /** 超时（秒）。 */
  timeout?: number;
  /** 是否要求自定义模板（4C 8GB）。 */
  require_custom_template?: boolean;
  /** 自定义模板 id 覆盖。 */
  template?: string;
  /** 任意附加字段。 */
  [key: string]: unknown;
}

/** 回传给队列的执行结果。 */
interface TaskResult {
  taskId: string;
  ok: boolean;
  keyId: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  error?: string;
}

/** 沙箱执行的统一返回结构。 */
interface ExecOutput {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

// ---------------------------------------------------------------------------
// 日志
// ---------------------------------------------------------------------------

function log(msg: string): void {
  const ts = new Date().toISOString();
  console.log(`${ts} [Worker] ${msg}`);
}

function logErr(msg: string): void {
  const ts = new Date().toISOString();
  console.error(`${ts} [Worker] ${msg}`);
}

// ---------------------------------------------------------------------------
// 运行状态
// ---------------------------------------------------------------------------

let shuttingDown = false;
/** 当前正在跑的任务数（用于优雅退出时等待）。 */
let inFlight = 0;

// ---------------------------------------------------------------------------
// key 选择（round-robin + 负载均衡）
// ---------------------------------------------------------------------------

let rrCursor = 0;

/**
 * 选择一个可用的 key。
 * - 若任务指定 key_preference 且该 key 有空位（并满足模板需求），优先用它。
 * - 否则在满足模板需求的 key 中选「负载最小」的；并列时 round-robin。
 * 返回 null 表示当前没有可用容量。
 */
function pickKey(task: Task): KeySlot | null {
  const needsCustom = Boolean(task.require_custom_template);

  const eligible = KEYS.filter((k) => {
    if (k.active >= MAX_CONCURRENCY_PER_KEY) return false;
    if (needsCustom && !k.canUseCustomTemplate) return false;
    return true;
  });

  if (eligible.length === 0) return null;

  // 1) 尊重 key_preference
  if (task.key_preference) {
    const pref = eligible.find((k) => k.id === task.key_preference);
    if (pref) return pref;
  }

  // 2) 选负载最小的；并列时按 round-robin 游标挑选，避免总是命中同一个
  const minActive = Math.min(...eligible.map((k) => k.active));
  const leastLoaded = eligible.filter((k) => k.active === minActive);

  const chosen = leastLoaded[rrCursor % leastLoaded.length];
  rrCursor = (rrCursor + 1) % KEYS.length;
  return chosen;
}

// ---------------------------------------------------------------------------
// E2B SDK 动态加载（可选）
// ---------------------------------------------------------------------------

type SandboxSdk = {
  Sandbox: {
    create(opts: Record<string, unknown>): Promise<unknown>;
  };
};

let sdkProbe: Promise<SandboxSdk | null> | null = null;

/**
 * 尝试动态加载 e2b SDK。若包未安装则返回 null（之后走 HTTP 直连）。
 * 只探测一次，结果缓存。
 */
function loadE2bSdk(): Promise<SandboxSdk | null> {
  if (sdkProbe) return sdkProbe;
  sdkProbe = (async () => {
    try {
      // 用变量化的模块名避免打包器/类型检查在缺包时报错。
      const moduleName = 'e2b';
      const mod = (await import(moduleName)) as unknown as SandboxSdk;
      if (mod && typeof (mod as SandboxSdk).Sandbox?.create === 'function') {
        log('E2B SDK detected, will use SDK path');
        return mod as SandboxSdk;
      }
      log('E2B SDK present but missing Sandbox.create, falling back to HTTP');
      return null;
    } catch {
      log('E2B SDK not installed, using direct HTTP API');
      return null;
    }
  })();
  return sdkProbe;
}

// ---------------------------------------------------------------------------
// 在 E2B 沙箱中执行代码
// ---------------------------------------------------------------------------

/**
 * 在指定 key 上创建沙箱并执行任务代码。
 * 走 SDK（若已安装），否则走 HTTP 直连。
 */
async function runInSandbox(task: Task, key: KeySlot): Promise<ExecOutput> {
  const timeoutSec = normalizeTimeout(task.timeout);
  const useCustom =
    (task.require_custom_template || task.template === CUSTOM_TEMPLATE_ID) && key.canUseCustomTemplate;
  const templateId = task.template ?? (useCustom ? CUSTOM_TEMPLATE_ID : 'base');

  // 给 E2B SDK / 远端读取的环境变量
  process.env.E2B_API_KEY = key.apiKey;
  process.env.E2B_API_URL = E2B_API_URL;
  process.env.E2B_DOMAIN = E2B_DOMAIN;

  const sdk = await loadE2bSdk();
  if (sdk) {
    return runViaSdk(sdk, task, key, templateId, timeoutSec);
  }
  return runViaHttp(task, key, templateId, timeoutSec);
}

/** 走 E2B SDK 执行。 */
async function runViaSdk(
  sdk: SandboxSdk,
  task: Task,
  key: KeySlot,
  templateId: string,
  timeoutSec: number,
): Promise<ExecOutput> {
  // E2B SDK v2.x: Sandbox.create(template, opts) 或 Sandbox.create(opts)
  const sandbox = (await sdk.Sandbox.create({
    template: templateId,
    apiKey: key.apiKey,
    domain: E2B_DOMAIN,
    timeoutMs: timeoutSec * 1000,
  })) as any;

  log(`sandbox created: ${sandbox.sandboxId ?? 'unknown'} on ${key.id}`);

  try {
    // 先安装依赖（仅 base 模板需要）
    if (Array.isArray(task.pip) && task.pip.length > 0) {
      const pipCmd = `pip install --quiet ${task.pip.map(shellQuote).join(' ')}`;
      await runCommandViaSdk(sandbox, pipCmd, timeoutSec);
    }

    const code = task.code ?? '';
    const lang = task.language ?? 'python';

    // 对于 Python 代码，写入文件再执行（避免 shell 转义问题）
    if (lang === 'python' && sandbox.files && typeof sandbox.files.write === 'function') {
      await sandbox.files.write('/tmp/task_code.py', code);
      return await runCommandViaSdk(sandbox, 'python3 /tmp/task_code.py', timeoutSec);
    }

    // 对于 bash 代码，写入文件再执行
    if (lang === 'bash' && sandbox.files && typeof sandbox.files.write === 'function') {
      await sandbox.files.write('/tmp/task_code.sh', code);
      return await runCommandViaSdk(sandbox, 'bash /tmp/task_code.sh', timeoutSec);
    }

    // 退化路径：直接通过 -c 参数执行
    if (lang === 'python') {
      return await runCommandViaSdk(sandbox, `python3 -c ${shellQuote(code)}`, timeoutSec);
    }
    return await runCommandViaSdk(sandbox, `bash -c ${shellQuote(code)}`, timeoutSec);
  } finally {
    try {
      if (typeof sandbox.kill === 'function') await sandbox.kill();
      else if (typeof sandbox.close === 'function') await sandbox.close();
    } catch (err) {
      logErr(`failed to kill sandbox on ${key.id}: ${errMsg(err)}`);
    }
  }
}

/** 通过 SDK 跑一条 shell 命令。 */
async function runCommandViaSdk(sandbox: any, cmd: string, timeoutSec: number): Promise<ExecOutput> {
  if (sandbox.commands && typeof sandbox.commands.run === 'function') {
    try {
      const res = await sandbox.commands.run(cmd, { timeoutMs: timeoutSec * 1000 });
      return {
        exitCode: typeof res?.exitCode === 'number' ? res.exitCode : 0,
        stdout: res?.stdout ?? '',
        stderr: res?.stderr ?? '',
      };
    } catch (err: any) {
      // E2B SDK v2.29+ throws CommandExitError on non-zero exit code
      if (typeof err?.exitCode === 'number') {
        return {
          exitCode: err.exitCode,
          stdout: err.stdout ?? '',
          stderr: err.stderr ?? '',
        };
      }
      throw err;
    }
  }
  if (typeof sandbox.process?.startAndWait === 'function') {
    const res = await sandbox.process.startAndWait(cmd);
    return {
      exitCode: typeof res?.exitCode === 'number' ? res.exitCode : 0,
      stdout: res?.stdout ?? '',
      stderr: res?.stderr ?? '',
    };
  }
  throw new Error('SDK sandbox has no recognizable command-run API');
}

/** 把 SDK 的 stdout/stderr（可能是数组/字符串）拼成字符串。 */
function collectSdkStream(stream: unknown): string {
  if (!stream) return '';
  if (typeof stream === 'string') return stream;
  if (Array.isArray(stream)) return stream.map((x) => String(x)).join('');
  return String(stream);
}

/**
 * 走 fetch 直连 E2B HTTP API。
 *
 * E2B 自托管的具体 REST 形态可能随版本变化，这里实现一个通用流程：
 *   1) POST /sandboxes        创建沙箱           -> { sandboxID }
 *   2) (可选) 执行 pip install
 *   3) 执行代码并采集输出
 *   4) DELETE /sandboxes/:id  销毁沙箱
 *
 * 不同版本的执行端点差异较大，这里对几种常见形态做兼容尝试。
 */
async function runViaHttp(
  task: Task,
  key: KeySlot,
  templateId: string,
  timeoutSec: number,
): Promise<ExecOutput> {
  const headers = {
    'Content-Type': 'application/json',
    'X-API-Key': key.apiKey,
    Authorization: `Bearer ${key.apiKey}`,
  };

  // 1) 创建沙箱
  const createResp = await fetchWithTimeout(
    `${E2B_API_URL}/sandboxes`,
    {
      method: 'POST',
      headers,
      body: JSON.stringify({
        templateID: templateId,
        timeout: timeoutSec,
        metadata: { source: 'geminiclaw-worker', taskId: task.id },
      }),
    },
    30_000,
  );

  if (!createResp.ok) {
    const body = await safeText(createResp);
    throw new Error(`create sandbox failed (${createResp.status}): ${body}`);
  }

  const created = (await safeJson(createResp)) as Record<string, any>;
  const sandboxId: string | undefined =
    created?.sandboxID ?? created?.sandboxId ?? created?.id ?? created?.sandbox?.sandboxID;

  if (!sandboxId) {
    throw new Error(`create sandbox: missing sandbox id in response: ${JSON.stringify(created)}`);
  }

  try {
    // 2) pip 安装（如有）
    if (Array.isArray(task.pip) && task.pip.length > 0) {
      const pipCmd = `pip install --quiet ${task.pip.map(shellQuote).join(' ')}`;
      await execViaHttp(sandboxId, pipCmd, headers, timeoutSec);
    }

    // 3) 执行代码
    const code = task.code ?? '';
    const runCmd = `python3 -c ${shellQuote(code)}`;
    return await execViaHttp(sandboxId, runCmd, headers, timeoutSec);
  } finally {
    // 4) 销毁沙箱
    try {
      await fetchWithTimeout(
        `${E2B_API_URL}/sandboxes/${sandboxId}`,
        { method: 'DELETE', headers },
        15_000,
      );
    } catch (err) {
      logErr(`failed to delete sandbox ${sandboxId} on ${key.id}: ${errMsg(err)}`);
    }
  }
}

/** 通过 HTTP 在沙箱内执行一条命令并采集输出。 */
async function execViaHttp(
  sandboxId: string,
  cmd: string,
  headers: Record<string, string>,
  timeoutSec: number,
): Promise<ExecOutput> {
  const resp = await fetchWithTimeout(
    `${E2B_API_URL}/sandboxes/${sandboxId}/process`,
    {
      method: 'POST',
      headers,
      body: JSON.stringify({ cmd, timeout: timeoutSec }),
    },
    (timeoutSec + 10) * 1000,
  );

  if (!resp.ok) {
    const body = await safeText(resp);
    throw new Error(`exec failed (${resp.status}): ${body}`);
  }

  const data = (await safeJson(resp)) as Record<string, any>;
  return {
    exitCode: typeof data?.exitCode === 'number' ? data.exitCode : (data?.exit_code ?? 0),
    stdout: data?.stdout ?? data?.output ?? '',
    stderr: data?.stderr ?? data?.error ?? '',
  };
}

// ---------------------------------------------------------------------------
// 队列交互
// ---------------------------------------------------------------------------

/**
 * long-poll 拉取待办任务。
 * 服务端在 wait 秒内若无任务返回 204/空体，则本函数返回 null。
 */
async function pollTask(): Promise<Task | null> {
  const url = `${QUEUE_BASE_URL}/tasks/pending?wait=${POLL_WAIT_SECONDS}`;
  const resp = await fetchWithTimeout(
    url,
    {
      method: 'GET',
      headers: { Authorization: `Bearer ${QUEUE_TOKEN}` },
    },
    // 比服务端 wait 多留 10s 余量
    (POLL_WAIT_SECONDS + 10) * 1000,
  );

  if (resp.status === 204) return null;
  if (!resp.ok) {
    const body = await safeText(resp);
    throw new Error(`poll failed (${resp.status}): ${body}`);
  }

  const text = await resp.text();
  if (!text || !text.trim()) return null;

  const parsed = JSON.parse(text) as Task | { task?: Task | null } | null;
  if (!parsed) return null;
  // 兼容 { task: {...} } 包装或裸 task
  const task = (parsed as { task?: Task }).task ?? (parsed as Task);
  // queue-server 用 taskId 字段，worker 内部用 id，做兼容映射
  if ((task as any).taskId && !task.id) {
    task.id = (task as any).taskId;
  }
  if (!task || !task.id) return null;
  return task;
}

/** 把执行结果回传给队列。 */
async function submitResult(result: TaskResult): Promise<void> {
  const url = `${QUEUE_BASE_URL}/tasks/${encodeURIComponent(result.taskId)}/result`;
  const resp = await fetchWithTimeout(
    url,
    {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${QUEUE_TOKEN}`,
      },
      body: JSON.stringify(result),
    },
    30_000,
  );

  if (!resp.ok) {
    const body = await safeText(resp);
    throw new Error(`submit result failed (${resp.status}): ${body}`);
  }
}

// ---------------------------------------------------------------------------
// 任务处理
// ---------------------------------------------------------------------------

/** 处理单个任务：占位 -> 执行 -> 回传结果 -> 释放占位。 */
async function handleTask(task: Task, key: KeySlot): Promise<void> {
  inFlight += 1;
  key.active += 1;
  const start = Date.now();
  log(`got task ${task.id}`);
  log(`executing on ${key.id} (active=${key.active}/${MAX_CONCURRENCY_PER_KEY})`);

  let result: TaskResult;
  try {
    const out = await runInSandbox(task, key);
    const durationMs = Date.now() - start;
    result = {
      taskId: task.id,
      ok: (out.exitCode ?? 0) === 0,
      keyId: key.id,
      exitCode: out.exitCode,
      stdout: out.stdout,
      stderr: out.stderr,
      durationMs,
    };
    log(`completed ${task.id} on ${key.id} in ${(durationMs / 1000).toFixed(1)}s (exit=${out.exitCode})`);
  } catch (err) {
    const durationMs = Date.now() - start;
    result = {
      taskId: task.id,
      ok: false,
      keyId: key.id,
      exitCode: null,
      stdout: '',
      stderr: '',
      durationMs,
      error: errMsg(err),
    };
    logErr(`task ${task.id} failed on ${key.id} after ${(durationMs / 1000).toFixed(1)}s: ${errMsg(err)}`);
  } finally {
    key.active = Math.max(0, key.active - 1);
    inFlight = Math.max(0, inFlight - 1);
  }

  // 回传结果（带少量重试，避免一次网络抖动丢结果）
  await submitResultWithRetry(result);
}

async function submitResultWithRetry(result: TaskResult): Promise<void> {
  const maxAttempts = 4;
  let delay = 1000;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await submitResult(result);
      return;
    } catch (err) {
      if (attempt === maxAttempts) {
        logErr(`giving up submitting result for ${result.taskId}: ${errMsg(err)}`);
        return;
      }
      logErr(`submit result for ${result.taskId} attempt ${attempt} failed: ${errMsg(err)}, retrying in ${delay}ms`);
      await sleep(delay);
      delay = Math.min(delay * 2, 15_000);
    }
  }
}

// ---------------------------------------------------------------------------
// 主循环
// ---------------------------------------------------------------------------

async function mainLoop(): Promise<void> {
  let backoff = 1000;
  const maxBackoff = 30_000;

  log(`starting. queue=${QUEUE_BASE_URL} keys=${KEYS.map((k) => k.id).join(',')} capacity=${KEYS.length * MAX_CONCURRENCY_PER_KEY}`);

  while (!shuttingDown) {
    // 全部 key 都打满时，稍等再轮询，避免空转拉到无法处理的任务。
    if (totalActive() >= KEYS.length * MAX_CONCURRENCY_PER_KEY) {
      await sleep(500);
      continue;
    }

    let task: Task | null = null;
    try {
      log('polling...');
      task = await pollTask();
      // 轮询成功，重置退避
      backoff = 1000;
    } catch (err) {
      logErr(`poll error: ${errMsg(err)}; reconnecting in ${backoff}ms`);
      await sleep(backoff);
      backoff = Math.min(backoff * 2, maxBackoff);
      continue;
    }

    if (!task) {
      // long-poll 超时无任务，立即继续
      continue;
    }

    if (shuttingDown) {
      // 正在关停就不再领新任务（这条任务会因未回传结果而被服务端重新调度）
      log(`shutting down, skipping task ${task.id}`);
      break;
    }

    const key = pickKey(task);
    if (!key) {
      // 没有可用容量（例如任务要求自定义模板但 KEY1 已满），稍等重试
      logErr(`no available key for task ${task.id} (require_custom=${Boolean(task.require_custom_template)}), retrying`);
      await sleep(1000);
      // 注意：此时任务还在队列里（我们没确认），下次会再拉到
      continue;
    }

    // 非阻塞地处理任务，让主循环可以继续拉取（填满并发槽位）
    void handleTask(task, key);
  }

  // 优雅退出：等待所有在跑任务完成
  if (inFlight > 0) {
    log(`waiting for ${inFlight} in-flight task(s) to finish...`);
    while (inFlight > 0) {
      await sleep(200);
    }
  }
  log('all tasks finished, bye');
}

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------

function totalActive(): number {
  return KEYS.reduce((sum, k) => sum + k.active, 0);
}

function normalizeTimeout(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_TASK_TIMEOUT;
  // 上限保护，避免离谱的超时把沙箱挂死
  return Math.min(Math.floor(n), 3600);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errMsg(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/** 用单引号安全包裹 shell 参数。 */
function shellQuote(s: string): string {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

/** 带超时的 fetch（基于 AbortController）。 */
async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function safeText(resp: Response): Promise<string> {
  try {
    return await resp.text();
  } catch {
    return '<no body>';
  }
}

async function safeJson(resp: Response): Promise<unknown> {
  const text = await safeText(resp);
  if (!text || !text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

// ---------------------------------------------------------------------------
// 信号处理 + 启动
// ---------------------------------------------------------------------------

function installSignalHandlers(): void {
  let triggered = false;
  const onSignal = (sig: string) => {
    if (triggered) {
      // 第二次信号：强制退出
      logErr(`received ${sig} again, forcing exit`);
      process.exit(1);
    }
    triggered = true;
    shuttingDown = true;
    log(`received ${sig}, will finish current task(s) then exit (send again to force)`);
  };

  process.on('SIGINT', () => onSignal('SIGINT'));
  process.on('SIGTERM', () => onSignal('SIGTERM'));

  // 防止未捕获的 rejection 导致进程崩溃
  process.on('unhandledRejection', (reason) => {
    logErr(`unhandled rejection: ${errMsg(reason)}`);
  });
  process.on('uncaughtException', (err) => {
    logErr(`uncaught exception: ${errMsg(err)}`);
  });
}

async function main(): Promise<void> {
  installSignalHandlers();
  try {
    await mainLoop();
    process.exit(0);
  } catch (err) {
    logErr(`fatal: ${errMsg(err)}`);
    process.exit(1);
  }
}

void main();
