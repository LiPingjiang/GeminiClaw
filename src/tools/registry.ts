// src/tools/registry.ts
import type { ToolDefinition, JSONSchema } from "./types.js";

export class ToolRegistry {
  private tools = new Map<string, ToolDefinition>();

  register(def: ToolDefinition): void {
    this.tools.set(def.name, def);
  }

  get(name: string): ToolDefinition | null {
    return this.tools.get(name) ?? null;
  }

  list(toolset?: string): ToolDefinition[] {
    const all = Array.from(this.tools.values());
    if (!toolset) return all;
    return all.filter((t) => t.toolset?.includes(toolset));
  }

  toAnthropicTools(): Array<{
    name: string;
    description: string;
    input_schema: JSONSchema;
  }> {
    return this.list().map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.schema,
    }));
  }
}

// Global singleton
export const registry = new ToolRegistry();
