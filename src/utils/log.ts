export function logError(msg: string | unknown, err?: unknown): void {
  const msgStr = typeof msg === 'string' ? msg : String(msg)
  process.stderr.write('[ink] ' + msgStr + (err ? ': ' + String(err) : '') + '\n')
}
