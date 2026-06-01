/**
 * src/lsp/index.ts
 * Lightweight LSP Integration — Delta-Baseline TypeScript Diagnostics
 *
 * 轻量版 LSP：在 post_tool_call 钩子中，检测 write/edit 完成后
 * 对 .ts 文件执行 tsc --noEmit，将新增 type error 追加到 tool result。
 *
 * Delta-Baseline 模式（对齐 Hermes）：
 *   1. 写前 snapshotBaseline(file) → 记录已有错误
 *   2. 写后 getDiagnostics(file) → 获取当前错误
 *   3. 只返回 **新增** 诊断（diff），避免"修一个错产生十个旧错"的循环
 *
 * 当前版本：TypeScript only（via tsc --noEmit）
 * 长期：接入真正的 LSP server（ts-server, pyright）
 */

import { execFile } from "child_process"
import { promisify } from "util"
import { resolve, extname } from "path"

const execFileAsync = promisify(execFile)

// ── Types ────────────────────────────────────────────────────────────────────

export interface Diagnostic {
  file: string
  line: number
  col: number
  code: string
  message: string
  severity: "error" | "warning"
}

export interface DiagnosticDiff {
  newErrors: Diagnostic[]
  resolvedErrors: Diagnostic[]
  totalCurrentErrors: number
}

// ── Baseline Store ───────────────────────────────────────────────────────────

/** In-memory baseline of known errors per file */
const baseline = new Map<string, Diagnostic[]>()

/**
 * Take a snapshot of current diagnostics for a file (call BEFORE modification).
 * If tsc fails to run, stores empty baseline (no preexisting errors assumed).
 */
export async function snapshotBaseline(
  filePath: string,
  workdir?: string,
): Promise<void> {
  if (!isTypeScriptFile(filePath)) return

  const diagnostics = await runTscDiagnostics(filePath, workdir)
  baseline.set(resolve(filePath), diagnostics)
}

/**
 * Get the delta diagnostics after a file modification.
 * Only returns NEW errors (not present in baseline).
 */
export async function getDiagnosticsDiff(
  filePath: string,
  workdir?: string,
): Promise<DiagnosticDiff> {
  if (!isTypeScriptFile(filePath)) {
    return { newErrors: [], resolvedErrors: [], totalCurrentErrors: 0 }
  }

  const current = await runTscDiagnostics(filePath, workdir)
  const resolvedPath = resolve(filePath)
  const baselineDiags = baseline.get(resolvedPath) ?? []

  // Find new errors (in current but not in baseline)
  const baselineKeys = new Set(baselineDiags.map(diagKey))
  const currentKeys = new Set(current.map(diagKey))

  const newErrors = current.filter((d) => !baselineKeys.has(diagKey(d)))
  const resolvedErrors = baselineDiags.filter((d) => !currentKeys.has(diagKey(d)))

  // Update baseline to current state
  baseline.set(resolvedPath, current)

  return {
    newErrors,
    resolvedErrors,
    totalCurrentErrors: current.length,
  }
}

/**
 * Format diagnostics for injection into tool result.
 * Returns empty string if no new errors.
 */
export function formatDiagnostics(diff: DiagnosticDiff): string {
  if (diff.newErrors.length === 0) return ""

  const lines = diff.newErrors
    .slice(0, 20) // Cap at 20 errors per file
    .map((d) => `  ${d.file}:${d.line}:${d.col} - ${d.code}: ${d.message}`)

  let result = `\n<diagnostics count="${diff.newErrors.length}" new="true">\n`
  result += lines.join("\n")
  if (diff.newErrors.length > 20) {
    result += `\n  ... and ${diff.newErrors.length - 20} more errors`
  }
  result += "\n</diagnostics>"
  return result
}

// ── Internal ─────────────────────────────────────────────────────────────────

function isTypeScriptFile(filePath: string): boolean {
  const ext = extname(filePath).toLowerCase()
  return ext === ".ts" || ext === ".tsx"
}

function diagKey(d: Diagnostic): string {
  return `${d.file}:${d.line}:${d.col}:${d.code}`
}

/**
 * Run `tsc --noEmit` and parse diagnostics for a specific file.
 * Falls back to project-wide check if file-specific check isn't meaningful.
 */
async function runTscDiagnostics(
  filePath: string,
  workdir?: string,
): Promise<Diagnostic[]> {
  const cwd = workdir ?? process.cwd()

  try {
    // Run tsc --noEmit and capture stderr/stdout (tsc outputs errors to stdout)
    await execFileAsync("npx", ["tsc", "--noEmit", "--pretty", "false"], {
      cwd,
      timeout: 30_000, // 30s timeout
      env: { ...process.env, NODE_OPTIONS: "" },
    })
    // If tsc exits 0, no errors
    return []
  } catch (err: unknown) {
    const execErr = err as { stdout?: string; stderr?: string; code?: number }
    // tsc exits with code 2 on type errors (non-zero)
    const output = execErr.stdout ?? execErr.stderr ?? ""
    return parseTscOutput(output, filePath)
  }
}

/**
 * Parse tsc output format:
 * src/file.ts(10,5): error TS2345: Argument of type ...
 */
function parseTscOutput(output: string, filterFile?: string): Diagnostic[] {
  const diagnostics: Diagnostic[] = []
  const lines = output.split("\n")

  // Match: file(line,col): error TSxxxx: message
  const regex = /^(.+?)\((\d+),(\d+)\):\s+(error|warning)\s+(TS\d+):\s+(.+)$/

  for (const line of lines) {
    const match = regex.exec(line.trim())
    if (!match) continue

    const [, file, lineStr, colStr, severity, code, message] = match
    const diag: Diagnostic = {
      file,
      line: parseInt(lineStr, 10),
      col: parseInt(colStr, 10),
      code,
      message,
      severity: severity as "error" | "warning",
    }

    // If filterFile is provided, only include diagnostics for that file
    if (filterFile) {
      const resolvedFilter = resolve(filterFile)
      const resolvedDiag = resolve(diag.file)
      if (resolvedDiag === resolvedFilter) {
        diagnostics.push(diag)
      }
    } else {
      diagnostics.push(diag)
    }
  }

  return diagnostics
}

// ── Clear baseline (for testing) ─────────────────────────────────────────────

export function clearBaseline(): void {
  baseline.clear()
}
