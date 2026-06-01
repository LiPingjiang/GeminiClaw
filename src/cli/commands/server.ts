// @ts-nocheck
/**
 * GeminiClaw server lifecycle commands
 * geminiclaw start / stop / restart / log
 */
import { existsSync, readFileSync, writeFileSync } from "fs";
import { join, resolve, dirname } from "path";
import { execSync, spawn } from "child_process";
import os from "os";
import yaml from "js-yaml";
import { printOutput, printError, printWarn } from "../lib/output.js";
import { findConfigFile } from "../lib/workspace.js";

// ── helpers ─────────────────────────────────────────────────────────────────

function findProjectRoot(): string {
  // 复用统一的 findConfigFile，从 config 路径推断项目根
  const cfgPath = findConfigFile();
  if (cfgPath) return dirname(cfgPath);
  throw new Error(
    "GeminiClaw config not found.\n" +
    "Looked in: cwd, project root (package.json), ~/.gemeniclaw/config.yaml\n" +
    "Set GC_CONFIG env var or place config.yaml in one of the above locations."
  );
}

function readServerConfig(root: string): { port: number; host: string; logFile: string; pidFile: string } {
  const cfgPath = join(root, "config.yaml");
  let port = 3000;
  let host = "127.0.0.1";
  if (existsSync(cfgPath)) {
    try {
      const raw: any = yaml.load(readFileSync(cfgPath, "utf-8"));
      port = raw?.server?.port ?? port;
      host = raw?.server?.host ?? host;
    } catch {}
  }
  return {
    port,
    host,
    logFile: join(root, "server.log"),
    pidFile: join(root, ".pid"),
  };
}

function readPid(pidFile: string): number | null {
  try {
    const raw = readFileSync(pidFile, "utf-8").trim();
    const pid = parseInt(raw, 10);
    return isNaN(pid) || pid === 0 ? null : pid;
  } catch {
    return null;
  }
}

function writePid(pidFile: string, pid: number) {
  writeFileSync(pidFile, String(pid), "utf-8");
}

function clearPid(pidFile: string) {
  try { writeFileSync(pidFile, "0", "utf-8"); } catch {}
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function getListeningPid(port: number): number | null {
  try {
    const out = execSync(`lsof -ti tcp:${port} 2>/dev/null || true`, { encoding: "utf-8" }).trim();
    if (!out) return null;
    const pid = parseInt(out.split("\n")[0], 10);
    return isNaN(pid) ? null : pid;
  } catch {
    return null;
  }
}

function serverStatus(root: string) {
  const cfg = readServerConfig(root);
  const pidFromFile = readPid(cfg.pidFile);
  const pidFromPort = getListeningPid(cfg.port);
  const pid = pidFromPort ?? (pidFromFile && isProcessAlive(pidFromFile) ? pidFromFile : null);
  const running = pid !== null;
  return { running, pid, port: cfg.port, host: cfg.host, logFile: cfg.logFile, pidFile: cfg.pidFile, root };
}

function waitForPort(port: number, timeoutMs = 10000): Promise<boolean> {
  const start = Date.now();
  return new Promise((resolve) => {
    const check = () => {
      try {
        const pid = getListeningPid(port);
        if (pid) { resolve(true); return; }
      } catch {}
      if (Date.now() - start > timeoutMs) { resolve(false); return; }
      setTimeout(check, 300);
    };
    check();
  });
}

// ── start ───────────────────────────────────────────────────────────────────

async function doStart(root: string, opts: { json?: boolean; wait?: boolean }) {
  const format = opts.json ? "json" : "human";
  const cfg = readServerConfig(root);

  // 检查是否已在运行
  const existing = getListeningPid(cfg.port);
  if (existing) {
    const msg = `GeminiClaw already running on :${cfg.port} (pid ${existing})`;
    printOutput({ ok: false, reason: "already_running", pid: existing, port: cfg.port }, `⚠️  ${msg}`, format);
    return;
  }

  // 检查 dist/index.js 是否存在
  const distEntry = join(root, "dist", "index.js");
  if (!existsSync(distEntry)) {
    printError(
      `dist/index.js not found. Run \`pnpm build\` in ${root} first.`,
      format
    );
    return;
  }

  // 检查 config.yaml
  const cfgFile = join(root, "config.yaml");
  if (!existsSync(cfgFile)) {
    printError(
      `config.yaml not found in ${root}. Copy config.example.yaml and fill in your settings.`,
      format
    );
    return;
  }

  if (format !== "json") {
    console.log(`🚀 Starting GeminiClaw in ${root} ...`);
  }

  // 后台启动
  const logFd = await import("fs").then((m) =>
    m.openSync(cfg.logFile, "a")
  );
  const child = spawn("node", [distEntry], {
    cwd: root,
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: { ...process.env, GC_CONFIG: cfgFile },
  });
  child.unref();
  writePid(cfg.pidFile, child.pid!);

  const wait = opts.wait !== false; // default wait=true
  if (wait) {
    const ok = await waitForPort(cfg.port, 12000);
    if (ok) {
      const pid = getListeningPid(cfg.port) ?? child.pid!;
      printOutput(
        { ok: true, pid, port: cfg.port },
        `✅ GeminiClaw started on :${cfg.port} (pid ${pid})\n📄 Log: ${cfg.logFile}`,
        format
      );
    } else {
      printOutput(
        { ok: false, reason: "timeout", pid: child.pid },
        `⚠️  Process started (pid ${child.pid}) but port :${cfg.port} not yet listening.\n    Check log: tail -f ${cfg.logFile}`,
        format
      );
    }
  } else {
    printOutput(
      { ok: true, pid: child.pid, port: cfg.port },
      `🚀 GeminiClaw launched (pid ${child.pid})\n📄 Log: ${cfg.logFile}`,
      format
    );
  }
}

// ── stop ────────────────────────────────────────────────────────────────────

function doStop(root: string, opts: { json?: boolean; force?: boolean }) {
  const format = opts.json ? "json" : "human";
  const cfg = readServerConfig(root);
  const pid = getListeningPid(cfg.port);

  if (!pid) {
    // 也尝试 pidFile
    const filePid = readPid(cfg.pidFile);
    if (filePid && isProcessAlive(filePid)) {
      const sig = opts.force ? "SIGKILL" : "SIGTERM";
      try {
        process.kill(filePid, sig);
        clearPid(cfg.pidFile);
        printOutput(
          { ok: true, pid: filePid, signal: sig },
          `🛑 Sent ${sig} to pid ${filePid}`,
          format
        );
      } catch (e) {
        printError(`Failed to kill pid ${filePid}: ${e}`, format);
      }
      return;
    }
    printOutput(
      { ok: false, reason: "not_running" },
      `⚠️  GeminiClaw is not running on :${cfg.port}`,
      format
    );
    return;
  }

  const sig = opts.force ? "SIGKILL" : "SIGTERM";
  try {
    process.kill(pid, sig);
    clearPid(cfg.pidFile);
    printOutput(
      { ok: true, pid, signal: sig },
      `🛑 GeminiClaw stopped (pid ${pid}, signal ${sig})`,
      format
    );
  } catch (e) {
    printError(`Failed to kill pid ${pid}: ${e}`, format);
  }
}

// ── restart ─────────────────────────────────────────────────────────────────

async function doRestart(root: string, opts: { json?: boolean; force?: boolean }) {
  const format = opts.json ? "json" : "human";
  const cfg = readServerConfig(root);
  const pid = getListeningPid(cfg.port);

  if (pid) {
    if (format !== "json") console.log(`🔄 Stopping GeminiClaw (pid ${pid}) ...`);
    const sig = opts.force ? "SIGKILL" : "SIGTERM";
    try { process.kill(pid, sig); } catch {}
    clearPid(cfg.pidFile);
    // 等待端口释放
    await new Promise<void>((res) => {
      const t = Date.now();
      const check = () => {
        if (!getListeningPid(cfg.port)) { res(); return; }
        if (Date.now() - t > 8000) { res(); return; }
        setTimeout(check, 300);
      };
      check();
    });
  } else {
    if (format !== "json") console.log(`ℹ️  GeminiClaw was not running, starting fresh ...`);
  }

  await doStart(root, opts);
}

// ── log ─────────────────────────────────────────────────────────────────────

function doLog(root: string, opts: { lines?: string; follow?: boolean; json?: boolean }) {
  const format = opts.json ? "json" : "human";
  const cfg = readServerConfig(root);

  if (!existsSync(cfg.logFile)) {
    printError(`Log file not found: ${cfg.logFile}`, format);
    return;
  }

  const n = parseInt(opts.lines ?? "50", 10) || 50;

  if (opts.follow) {
    // tail -f
    const child = spawn("tail", ["-n", String(n), "-f", cfg.logFile], {
      stdio: "inherit",
    });
    child.on("exit", (code) => process.exit(code ?? 0));
    process.on("SIGINT", () => { child.kill(); process.exit(0); });
  } else {
    try {
      const out = execSync(`tail -n ${n} "${cfg.logFile}"`, { encoding: "utf-8" });
      if (format === "json") {
        console.log(JSON.stringify({ logFile: cfg.logFile, lines: out.split("\n") }));
      } else {
        console.log(`📄 ${cfg.logFile} (last ${n} lines)\n`);
        process.stdout.write(out);
      }
    } catch (e) {
      printError(String(e), format);
    }
  }
}

// ── register ─────────────────────────────────────────────────────────────────

export function registerServerCommands(program: any) {
  // ── start ──
  program
    .command("start")
    .description(`Start GeminiClaw server in the background

WHAT
  Launches node dist/index.js detached, appends stdout+stderr to server.log,
  writes PID to .pid, then waits up to 12s for the port to open.

REQUIRES
  config.yaml must exist in the project root.
  dist/index.js must exist (run \`pnpm build\` first).`)
    .option("--no-wait", "Don't wait for port to open")
    .option("--json", "Output as JSON")
    .action(async (opts) => {
      try {
        const root = findProjectRoot();
        await doStart(root, { json: opts.json, wait: opts.wait });
      } catch (e) {
        printError(String(e), opts.json ? "json" : "human");
      }
    });

  // ── stop ──
  program
    .command("stop")
    .description(`Stop GeminiClaw server

WHAT
  Sends SIGTERM (or SIGKILL with --force) to the process listening on the
  configured port. Falls back to .pid file if lsof returns nothing.`)
    .option("--force", "Send SIGKILL instead of SIGTERM")
    .option("--json", "Output as JSON")
    .action((opts) => {
      try {
        const root = findProjectRoot();
        doStop(root, opts);
      } catch (e) {
        printError(String(e), opts.json ? "json" : "human");
      }
    });

  // ── restart ──
  program
    .command("restart")
    .description(`Restart GeminiClaw server

WHAT
  Stops the running server (if any), waits for the port to free,
  then starts a fresh process. Equivalent to stop + start.`)
    .option("--force", "Use SIGKILL to stop the old process")
    .option("--json", "Output as JSON")
    .action(async (opts) => {
      try {
        const root = findProjectRoot();
        await doRestart(root, opts);
      } catch (e) {
        printError(String(e), opts.json ? "json" : "human");
      }
    });

  // ── log ──
  program
    .command("log")
    .description(`Tail GeminiClaw server log

USAGE
  geminiclaw log             # last 50 lines
  geminiclaw log -n 100      # last 100 lines
  geminiclaw log -f          # follow (like tail -f)`)
    .option("-n, --lines <n>", "Number of lines to show", "50")
    .option("-f, --follow", "Follow log (tail -f)")
    .option("--json", "Output as JSON")
    .action((opts) => {
      try {
        const root = findProjectRoot();
        doLog(root, opts);
      } catch (e) {
        printError(String(e), opts.json ? "json" : "human");
      }
    });
}
