// src/tools/execute_script.ts
/**
 * execute_script — batch shell execution tool.
 *
 * Inspired by Hermes's execute_code: lets the model collapse multiple
 * sequential exec calls into a single script, reducing iteration count.
 * This tool gets a budget REFUND in the iteration budget system,
 * incentivizing the model to batch operations.
 */
import { spawn } from "node:child_process";
import { registry } from "./registry.js";
import type { ToolResult, ToolContext } from "./types.js";

const MAX_OUTPUT_CHARS = 16_000;
const HEAD_TAIL_CHARS = 4_000;
const MAX_SCRIPT_LENGTH = 20_000;

function truncateOutput(output: string): string {
  if (output.length <= MAX_OUTPUT_CHARS) return output;
  const head = output.slice(0, HEAD_TAIL_CHARS);
  const tail = output.slice(-HEAD_TAIL_CHARS);
  const omitted = output.length - HEAD_TAIL_CHARS * 2;
  return `${head}\n\n⚠️ [... ${omitted} chars omitted ...]\n\n${tail}`;
}

async function executeScriptHandler(
  params: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const script = String(params["script"] ?? "");
  const timeout = (params["timeout"] as number) ?? 60;
  const workdir = (params["workdir"] as string) ?? ctx.workdir;

  if (!script.trim()) {
    return { type: "error", error: "Script is empty" };
  }

  if (script.length > MAX_SCRIPT_LENGTH) {
    return {
      type: "error",
      error: `Script too long (${script.length} chars, max ${MAX_SCRIPT_LENGTH})`,
    };
  }

  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    // Use set -e so script stops on first error
    const fullScript = `set -e\n${script}`;
    const proc = spawn("sh", ["-c", fullScript], {
      cwd: workdir,
      env: process.env,
    });

    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill("SIGTERM");
      const partial = truncateOutput(stdout + stderr);
      resolve({
        type: "error",
        error: `Script timed out after ${timeout}s\nPartial output:\n${partial}`,
      });
    }, timeout * 1000);

    proc.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    proc.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    proc.on("close", (code) => {
      if (timedOut) return;
      clearTimeout(timer);
      const combined = stdout + (stderr ? `\nSTDERR:\n${stderr}` : "");
      const output = truncateOutput(combined);

      if (code !== 0) {
        resolve({
          type: "error",
          error: `Script exited with code ${code ?? "null"}\n${output}`,
        });
      } else {
        resolve({ type: "text", text: output });
      }
    });

    proc.on("error", (err) => {
      if (timedOut) return;
      clearTimeout(timer);
      resolve({
        type: "error",
        error: `Failed to spawn process: ${err.message}`,
      });
    });
  });
}

registry.register({
  name: "execute_script",
  description: `Execute a multi-line bash script as a single unit. Use this when you need to run multiple commands that would otherwise require separate 'exec' tool calls.

PREFER this over multiple separate 'exec' calls when:
- You need to run 3+ independent commands (ls, grep, cat, ssh queries, etc.)
- Commands have simple sequential dependencies (cd && cmd1 && cmd2)
- You're doing exploratory work (checking multiple files/directories/services)
- You need to combine SSH commands: ssh host "cmd1 && cmd2 && cmd3"

The script runs with 'set -e' (stops on first error). All stdout/stderr is collected and returned together.

Example:
  script: |
    echo "=== Git status ==="
    git status
    echo "=== Recent commits ==="
    git log --oneline -5
    echo "=== Disk usage ==="
    df -h /`,
  schema: {
    type: "object",
    properties: {
      script: {
        type: "string",
        description:
          "Multi-line bash script to execute. Runs with set -e (stops on first error).",
      },
      timeout: {
        type: "number",
        description: "Timeout in seconds (default 60, max 300)",
      },
      workdir: {
        type: "string",
        description: "Working directory for the script",
      },
    },
    required: ["script"],
  },
  handler: executeScriptHandler,
  toolset: ["default"],
  requiresApproval: true,
  executionMode: "sequential",
});
