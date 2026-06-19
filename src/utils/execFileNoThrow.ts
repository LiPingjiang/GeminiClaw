import { execFile } from 'child_process'

interface ExecResult {
  code: number | null
  stdout: string
  stderr: string
}

export function execFileNoThrow(
  file: string,
  args: string[],
  opts?: { input?: string; timeout?: number; useCwd?: boolean },
): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = execFile(file, args, { timeout: opts?.timeout }, (err, stdout, stderr) => {
      resolve({
        code: err ? (err.code !== undefined ? Number(err.code) : 1) : 0,
        stdout: stdout ?? '',
        stderr: stderr ?? '',
      })
    })
    if (opts?.input && child.stdin) {
      child.stdin.write(opts.input)
      child.stdin.end()
    }
  })
}
