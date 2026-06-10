// src/tools/types.ts

export interface JSONSchema {
  type: string;
  properties?: Record<string, JSONSchema>;
  required?: string[];
  description?: string;
  items?: JSONSchema;
  enum?: unknown[];
  [key: string]: unknown;
}

// ── Multimodal content parts for tool results ────────────────────────────────
export interface TextContentBlock {
  type: "text";
  text: string;
}

export interface ImageContentBlock {
  type: "image_url";
  image_url: { url: string; detail?: string };
}

export type MultimodalContentBlock = TextContentBlock | ImageContentBlock;

// ── Tool result types ────────────────────────────────────────────────────────
export type ToolResult =
  | { type: "text"; text: string }
  | { type: "error"; error: string }
  | {
      type: "multimodal";
      /** Content blocks: text + image interleaved (Hermes-style envelope) */
      content: MultimodalContentBlock[];
      /** Plain-text fallback for non-vision models or guardrail hashing */
      textSummary: string;
    };

export interface ToolContext {
  sessionId: string;
  workdir: string;
  logger: {
    info(msg: string, ...args: unknown[]): void;
    warn(msg: string, ...args: unknown[]): void;
    error(msg: string, ...args: unknown[]): void;
  };
  /** Per-invocation extra context (e.g. db, userId) injected by the channel handler. */
  extra?: Record<string, unknown>;
}

export type ToolHandler = (
  params: Record<string, unknown>,
  ctx: ToolContext,
) => Promise<ToolResult>;

export interface ToolDefinition {
  name: string;
  description: string;
  schema: JSONSchema;
  handler: ToolHandler;
  toolset?: string[];
  requiresApproval?: boolean;
  executionMode?: "sequential" | "parallel";
}
