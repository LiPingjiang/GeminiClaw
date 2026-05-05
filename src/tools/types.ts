export interface JSONSchema {
  type: string
  properties?: Record<string, JSONSchema>
  required?: string[]
  description?: string
  items?: JSONSchema
  enum?: unknown[]
  [key: string]: unknown
}

export type ToolResult =
  | { type: 'text'; text: string }
  | { type: 'error'; error: string }

export interface ToolContext {
  sessionId: string
  workdir: string
  logger: {
    info(msg: string, ...args: unknown[]): void
    warn(msg: string, ...args: unknown[]): void
    error(msg: string, ...args: unknown[]): void
  }
}

export type ToolHandler = (
  params: Record<string, unknown>,
  ctx: ToolContext
) => Promise<ToolResult>

export interface ToolDefinition {
  name: string
  description: string
  schema: JSONSchema
  handler: ToolHandler
  toolset?: string[]
  requiresApproval?: boolean
  executionMode?: 'sequential' | 'parallel'
}
