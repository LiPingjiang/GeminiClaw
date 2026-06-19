// Stub for Claude Code's bootstrap state — unused functions return safe defaults.
// Real GeminiClaw session state is managed by the TUI reducer in app.tsx.

let _sessionId: string | undefined
let _projectRoot: string = process.cwd()

export function getSessionId(): string | undefined { return _sessionId }
export function setSessionId(id: string): void { _sessionId = id }

export function getProjectRoot(): string { return _projectRoot }
export function setProjectRoot(dir: string): void { _projectRoot = dir }

export function getOriginalCwd(): string { return process.cwd() }

export function flushInteractionTime(): void {}
export function getSdkBetas(): string[] { return [] }
export function isSessionPersistenceDisabled(): boolean { return false }
export function markPostCompaction(): void {}
export function updateLastInteractionTime(): void {}
export function markScrollActivity(): void {}
export function getKairosActive(): boolean { return false }
export function getUserMsgOptIn(): boolean { return false }
export function getIsRemoteMode(..._args: any[]): any { return false }
export function getLastAPIRequest(..._args: any[]): any { return undefined as any }
export function getMainThreadAgentType(..._args: any[]): any { return undefined as any }

// Session switching (used by /session command in REPL.tsx)
export function switchSession(_sessionId: string, _cwd: string | null): void {}
export function setCostStateForRestore(_costs: any): void {}

// Last interaction time (used by proactive/kairos features)
let _lastInteractionTime = Date.now()
export function getLastInteractionTime(): number { return _lastInteractionTime }

// Turn metric tracking (used by REPL.tsx to compute API metrics)
let _turnHookDurationMs = 0
let _turnHookCount = 0
export function getTurnHookDurationMs(): number { return _turnHookDurationMs }
export function getTurnHookCount(): number { return _turnHookCount }
export function resetTurnHookDuration(): void { _turnHookDurationMs = 0; _turnHookCount = 0 }

let _turnToolDurationMs = 0
let _turnToolCount = 0
export function getTurnToolDurationMs(): number { return _turnToolDurationMs }
export function getTurnToolCount(): number { return _turnToolCount }
export function resetTurnToolDuration(): void { _turnToolDurationMs = 0; _turnToolCount = 0 }

let _turnClassifierDurationMs = 0
let _turnClassifierCount = 0
export function getTurnClassifierDurationMs(): number { return _turnClassifierDurationMs }
export function getTurnClassifierCount(): number { return _turnClassifierCount }
export function resetTurnClassifierDuration(): void { _turnClassifierDurationMs = 0; _turnClassifierCount = 0 }

// Token budget / output token tracking
export function snapshotOutputTokensForTurn(_tokens: number | null): void {}
export function getCurrentTurnTokenBudget(): number { return 0 }
export function getTurnOutputTokens(): number { return 0 }
export function getBudgetContinuationCount(): number { return 0 }
export function getTotalInputTokens(): number { return 0 }
export function getSlowOperations(..._args: any[]): any { return undefined as any }
