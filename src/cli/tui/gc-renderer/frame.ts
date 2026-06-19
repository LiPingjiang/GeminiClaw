type FrameCb = (t: number) => void

class FrameScheduler {
  private subs = new Set<FrameCb>()
  private timer: ReturnType<typeof setInterval> | null = null
  private start = Date.now()
  private _render: (() => void) | null = null

  setRenderCallback(fn: () => void): void { this._render = fn }

  subscribe(cb: FrameCb): () => void {
    this.subs.add(cb)
    this._ensure()
    return () => { this.subs.delete(cb); if (this.subs.size === 0) this._stop() }
  }

  scheduleRender(): void {
    setImmediate(() => this._render?.())
  }

  private _ensure(): void {
    if (this.timer) return
    this.start = Date.now()
    this.timer = setInterval(() => {
      const t = Date.now() - this.start
      for (const cb of this.subs) cb(t)
      this._render?.()
    }, 50)
    if ((this.timer as any).unref) (this.timer as any).unref()
  }

  private _stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null }
  }
}

export const frameScheduler = new FrameScheduler()

export function useAnimationFrame(callback?: (t: number) => void): number {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const React = require('react') as typeof import('react')
  const [time, setTime] = React.useState(0)
  React.useEffect(() => {
    return frameScheduler.subscribe((t) => {
      callback?.(t)
      setTime(t)
    })
  }, [])
  return time
}
