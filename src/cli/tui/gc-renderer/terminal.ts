export const ENTER_ALT_SCREEN = '\x1b[?1049h\x1b[?25l'
export const EXIT_ALT_SCREEN  = '\x1b[?25h\x1b[?1049l'
export const ENABLE_MOUSE     = '\x1b[?1003h\x1b[?1006h'
export const DISABLE_MOUSE    = '\x1b[?1006l\x1b[?1003l'
export const CLEAR_SCREEN     = '\x1b[2J\x1b[H'

export interface MouseEvent {
  button: number
  col: number
  row: number
  type: 'press' | 'release' | 'move'
}

export interface KeyEvent {
  key: string
  ctrl: boolean
  shift: boolean
  meta: boolean
  sequence: string
  input: string
}

export function parseMouse(buf: string): MouseEvent | null {
  const m = buf.match(/\x1b\[<(\d+);(\d+);(\d+)([Mm])/)
  if (!m) return null
  return {
    button: parseInt(m[1]!, 10),
    col: parseInt(m[2]!, 10),
    row: parseInt(m[3]!, 10),
    type: m[4] === 'M' ? 'press' : 'release',
  }
}

export function parseKey(buf: Buffer): KeyEvent {
  const str = buf.toString('utf-8')
  const mk = (key: string, ctrl = false, shift = false): KeyEvent =>
    ({ key, ctrl, shift, meta: false, sequence: str, input: ctrl || shift ? '' : str })

  if (str === '\x03') return mk('c', true)
  if (str === '\x04') return mk('d', true)
  if (str === '\r' || str === '\n') return mk('return')
  if (str === '\x1b[A' || str === '\x1bOA') return mk('up')
  if (str === '\x1b[B' || str === '\x1bOB') return mk('down')
  if (str === '\x1b[C' || str === '\x1bOC') return mk('right')
  if (str === '\x1b[D' || str === '\x1bOD') return mk('left')
  if (str === '\x1b[1;5A') return mk('up', true)
  if (str === '\x1b[1;5B') return mk('down', true)
  if (str === '\x1b[1;5C') return mk('right', true)
  if (str === '\x1b[1;5D') return mk('left', true)
  if (str === '\x7f' || str === '\b') return mk('backspace')
  if (str === '\x1b[3~') return mk('delete')
  if (str === '\x1b') return mk('escape')
  if (str === '\t') return mk('tab')
  if (str === '\x1b[H' || str === '\x1b[1~') return mk('home')
  if (str === '\x1b[F' || str === '\x1b[4~') return mk('end')
  if (str === '\x1b[5~') return mk('pageup')
  if (str === '\x1b[6~') return mk('pagedown')
  if (str === '\x1b\r' || str === '\x1b[13;2u') return mk('return', false, true)

  // Ctrl+letter
  if (str.length === 1 && str.charCodeAt(0) >= 1 && str.charCodeAt(0) <= 26) {
    return mk(String.fromCharCode(str.charCodeAt(0) + 96), true)
  }

  // Regular printable
  if (!str.startsWith('\x1b') && str.length >= 1) {
    return { key: str, ctrl: false, shift: false, meta: false, sequence: str, input: str }
  }

  return { key: '', ctrl: false, shift: false, meta: false, sequence: str, input: '' }
}

export type InputHandler = (key: KeyEvent) => void
export type MouseHandler = (evt: MouseEvent) => void
export type ResizeHandler = (cols: number, rows: number) => void

export class TerminalController {
  private _inputHandler: InputHandler | null = null
  private _mouseHandler: MouseHandler | null = null
  private _resizeHandler: ResizeHandler | null = null
  private _isRawMode = false
  private _mouseEnabled = false

  enterAltScreen(enableMouse = true): void {
    process.stdout.write(ENTER_ALT_SCREEN)
    process.stdout.write(CLEAR_SCREEN)
    if (enableMouse) {
      process.stdout.write(ENABLE_MOUSE)
      this._mouseEnabled = true
    }
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true)
      this._isRawMode = true
    }
    process.stdin.resume()
    process.stdin.on('data', this._onData)
    process.stdout.on('resize', this._onResize)
  }

  exitAltScreen(): void {
    if (this._mouseEnabled) process.stdout.write(DISABLE_MOUSE)
    process.stdout.write(EXIT_ALT_SCREEN)
    if (this._isRawMode && process.stdin.isTTY) process.stdin.setRawMode(false)
    process.stdin.pause()
    process.stdin.off('data', this._onData)
    process.stdout.off('resize', this._onResize)
  }

  onInput(h: InputHandler): void { this._inputHandler = h }
  onMouse(h: MouseHandler): void { this._mouseHandler = h }
  onResize(h: ResizeHandler): void { this._resizeHandler = h }

  private _onData = (buf: Buffer): void => {
    const str = buf.toString('utf-8')
    if (str.includes('\x1b[<')) {
      const mouse = parseMouse(str)
      if (mouse) { this._mouseHandler?.(mouse); return }
    }
    this._inputHandler?.(parseKey(buf))
  }

  private _onResize = (): void => {
    this._resizeHandler?.(process.stdout.columns ?? 80, process.stdout.rows ?? 24)
  }
}
