import stringWidth from 'string-width'
import stripAnsi from 'strip-ansi'

export function cursorTo(col: number, row: number): string {
  return `\x1b[${row + 1};${col + 1}H`
}

export function padAnsiLine(line: string, targetWidth: number): string {
  const visible = stringWidth(stripAnsi(line))
  if (visible === targetWidth) return line
  if (visible > targetWidth) return stripAnsi(line).slice(0, targetWidth)
  return line + '\x1b[0m' + ' '.repeat(targetWidth - visible)
}

export class ScreenBuffer {
  private cols: number
  private rows: number
  private curr: string[]
  private prev: string[]

  constructor(cols: number, rows: number) {
    this.cols = cols
    this.rows = rows
    const blank = ' '.repeat(cols)
    this.curr = Array(rows).fill(blank)
    this.prev = Array(rows).fill('\x00')
  }

  resize(cols: number, rows: number): void {
    this.cols = cols
    this.rows = rows
    const blank = ' '.repeat(cols)
    this.curr = Array(rows).fill(blank)
    this.prev = Array(rows).fill('\x00')
  }

  writeLine(y: number, line: string): void {
    if (y < 0 || y >= this.rows) return
    this.curr[y] = padAnsiLine(line, this.cols)
  }

  clearRows(yStart: number, yEnd: number): void {
    const blank = ' '.repeat(this.cols)
    for (let y = yStart; y < yEnd && y < this.rows; y++) {
      this.curr[y] = blank
    }
  }

  commit(): void {
    const out: string[] = []
    for (let y = 0; y < this.rows; y++) {
      const cur = this.curr[y]!
      if (cur !== this.prev[y]) {
        out.push(cursorTo(0, y) + cur)
        this.prev[y] = cur
      }
    }
    if (out.length > 0) process.stdout.write(out.join(''))
    const blank = ' '.repeat(this.cols)
    this.curr = Array(this.rows).fill(blank)
  }

  invalidate(): void {
    this.prev = Array(this.rows).fill('\x00')
  }

  get width(): number { return this.cols }
  get height(): number { return this.rows }
}
