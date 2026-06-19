export type AppState = Record<string, unknown>
export function useAppState<T>(_selector: (s: AppState) => T): T { return undefined as T }
export function useSetAppState(): (update: ((prev: AppState) => Partial<AppState>) | Partial<AppState>) => void { return () => {} }
export function useAppStateStore(): any { return {} }
