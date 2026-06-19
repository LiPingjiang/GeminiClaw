export function getModel(): any { return {} }
export type ModelConfig = any
export type ModelName = any
export function getRuntimeMainLoopModel(..._args: any[]): any { return undefined as any }
export function renderModelName(..._args: any[]): any { return undefined as any }
export function getMainLoopModel(..._args: any[]): any { return undefined as any }
export function isOpus1mMergeEnabled(..._args: any[]): any { return false }
export function modelDisplayString(..._args: any[]): any { return undefined as any }
export function getDefaultMainLoopModel(..._args: any[]): any { return undefined as any }
export function parseUserSpecifiedModel(model: any): string { return (model && typeof model === "object" ? (model.id ?? model.display_name ?? "claude-sonnet-4-6") : String(model ?? "claude-sonnet-4-6")) }
export function getDefaultSonnetModel(..._args: any[]): any { return undefined as any }

// Ensure safe handling of null/undefined model values
const _orig_parseUserSpecifiedModel = typeof parseUserSpecifiedModel !== 'undefined' 
  ? parseUserSpecifiedModel : (..._: any[]) => 'claude-sonnet-4-6'

export function gP(m: any): string { return parseUserSpecifiedModel(m) }
