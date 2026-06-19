// GeminiClaw stub for Claude Code's AppState
// Provides non-null defaults so REPL.tsx renders without crashing

const defaultAppState: Record<string, any> = {
  toolPermissionContext: { 
    mode: 'default',
    additionalWorkingDirectories: new Map(),
    rules: [],
  },
  verbose: false,
  mcp: { clients: [], configs: {}, tools: [], commands: [], resources: [] },
  plugins: [],
  agentDefinitions: { activeAgents: [], allAgents: [] },
  fileHistory: { snapshots: [], trackedFiles: new Set() },
  initialMessage: null,
  spinnerTip: null,
  expandedView: null,
  pendingWorkerRequest: null,
  pendingSandboxRequest: null,
  teamContext: null,
  tasks: {},
  workerSandboxPermissions: { queue: [] },
  elicitation: { queue: [] },
  isLoading: false,
  messages: [],
  screen: 'prompt',
  theme: 'dark',
  statusLine: null,
  statusLineText: undefined,
  todoFeatureEnabled: false,
  showExpandedTodos: false,
  mainLoopModel: { id: "claude-sonnet-4-6", display_name: "Claude Sonnet 4" },
  maxRateLimitFallbackActive: false,
  backgroundTasks: {},
  checkpointing: { status: 'uninitialized', checkpoints: {}, shadowRepoPath: undefined, saveError: undefined, saving: false, autocheckpointEnabled: false },
  companionReaction: null,
  output_style: 'auto',
}

let _appState = { ...defaultAppState }
const _listeners: Set<() => void> = new Set()

function subscribe(listener: () => void): () => void {
  _listeners.add(listener)
  return () => { _listeners.delete(listener) }
}

function notify(): void {
  for (const l of _listeners) l()
}

export type AppState = typeof defaultAppState
export function useAppState<T>(selector: (s: AppState) => T): T {
  // Simple implementation - doesn't actually subscribe to changes but returns defaults
  try { return selector(_appState as AppState) } catch { return undefined as T }
}
export function useSetAppState(): (fn: ((prev: AppState) => Partial<AppState>) | Partial<AppState>) => void {
  return (fn) => {
    const update = typeof fn === 'function' ? fn(_appState as AppState) : fn
    _appState = { ..._appState, ...update }
    notify()
  }
}
export function useAppStateStore(): any {
  return { getState: () => _appState, subscribe, setState: (fn: any) => useSetAppState()(fn) }
}
export function getAppState(): AppState { return _appState as AppState }

export function useAppStateMaybeOutsideOfProvider<T>(selector: (s: AppState) => T): T {
  try { return selector(_appState as AppState) } catch { return undefined as T }
}
export function useOnChangeAppState(selector: any, handler: any): void {}
export function onChangeAppState(selector: any, handler: any): () => void { return () => {} }

