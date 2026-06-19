// Stub for Claude Code's QueryGuard — provides useSyncExternalStore-compatible interface
export class QueryGuard {
  private _active = false
  private _listeners = new Set<() => void>()
  
  subscribe = (listener: () => void): (() => void) => {
    this._listeners.add(listener)
    return () => { this._listeners.delete(listener) }
  }
  
  getSnapshot = (): boolean => this._active
  
  tryStart(): boolean { this._active = true; this._notify(); return true }
  end(): void { this._active = false; this._notify() }
  reserve(): void {}
  cancelReservation(): void {}
  
  private _notify() { for (const l of this._listeners) l() }
}

// Also export as function for compat
export function createQueryGuard(): QueryGuard { return new QueryGuard() }
export default QueryGuard
