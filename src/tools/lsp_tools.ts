// @ts-nocheck
import { registry } from './registry.js';
import { getOrStartLspClient, getLspClient, type LspLocation } from './lsp/index.js';

/**
 * goto_definition — 跳转到定义（LSP）
 */
registry.register({
  name: 'goto_definition',
  description: 'Go to the definition of a symbol using LSP. Returns file path and line/column.',
  schema: {
    type: 'object',
    properties: {
      filePath: { type: 'string', description: 'Absolute path to the source file' },
      line: { type: 'number', description: '0-based line number' },
      character: { type: 'number', description: '0-based character position' },
    },
    required: ['filePath', 'line', 'character'],
  },
  handler: async (params, ctx) => {
    const client = await getOrStartLspClient(ctx.workdir);
    if (!client) {
      return { type: 'error' as const, error: 'No language server detected for this workspace.' };
    }
    const locations = await client.gotoDefinition(
      String(params.filePath),
      Number(params.line),
      Number(params.character),
    );
    if (!locations || locations.length === 0) {
      return { type: 'text' as const, text: 'No definition found.' };
    }
    const lines = locations.map((loc: LspLocation) =>
      `${loc.uri.replace('file://', '')}:${loc.range.start.line + 1}:${loc.range.start.character + 1}`,
    );
    return { type: 'text' as const, text: lines.join('\n') };
  },
});

/**
 * find_references — 查找引用（LSP）
 */
registry.register({
  name: 'find_references',
  description: 'Find all references to a symbol using LSP.',
  schema: {
    type: 'object',
    properties: {
      filePath: { type: 'string', description: 'Absolute path to the source file' },
      line: { type: 'number', description: '0-based line number' },
      character: { type: 'number', description: '0-based character position' },
    },
    required: ['filePath', 'line', 'character'],
  },
  handler: async (params, ctx) => {
    const client = await getOrStartLspClient(ctx.workdir);
    if (!client) {
      return { type: 'error' as const, error: 'No language server detected for this workspace.' };
    }
    const locations = await client.findReferences(
      String(params.filePath),
      Number(params.line),
      Number(params.character),
    );
    if (locations.length === 0) {
      return { type: 'text' as const, text: 'No references found.' };
    }
    const lines = locations.map((loc: LspLocation) =>
      `${loc.uri.replace('file://', '')}:${loc.range.start.line + 1}:${loc.range.start.character + 1}`,
    );
    return { type: 'text' as const, text: lines.join('\n') };
  },
});

/**
 * workspace_symbol — 全局符号搜索（LSP）
 */
registry.register({
  name: 'workspace_symbol',
  description: 'Search for symbols across the entire workspace using LSP.',
  schema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Symbol name or partial name to search' },
    },
    required: ['query'],
  },
  handler: async (params, ctx) => {
    const client = await getOrStartLspClient(ctx.workdir);
    if (!client) {
      return { type: 'error' as const, error: 'No language server detected for this workspace.' };
    }
    const symbols = await client.workspaceSymbol(String(params.query));
    if (symbols.length === 0) {
      return { type: 'text' as const, text: 'No symbols found.' };
    }
    const lines = symbols.map(
      (s: any) => `${s.name} (${kindName(s.kind)}) — ${s.location.uri.replace('file://', '')}:${s.location.range.start.line + 1}`,
    );
    return { type: 'text' as const, text: lines.join('\n') };
  },
});

/**
 * document_symbols — 文件内符号列表（LSP）
 */
registry.register({
  name: 'document_symbols',
  description: 'List all symbols (functions, classes, variables) in a file using LSP.',
  schema: {
    type: 'object',
    properties: {
      filePath: { type: 'string', description: 'Absolute path to the source file' },
    },
    required: ['filePath'],
  },
  handler: async (params, ctx) => {
    const client = await getOrStartLspClient(ctx.workdir);
    if (!client) {
      return { type: 'error' as const, error: 'No language server detected for this workspace.' };
    }
    const symbols = await client.documentSymbols(String(params.filePath));
    const lines = formatDocumentSymbols(symbols, 0);
    return { type: 'text' as const, text: lines.join('\n') || 'No symbols found.' };
  },
});

// ── 辅助函数 ────────────────────────────────────────────────────────────────

function kindName(kind: number): string {
  const map: Record<number, string> = {
    1: 'File', 2: 'Module', 3: 'Namespace', 4: 'Package', 5: 'Class',
    6: 'Method', 7: 'Property', 8: 'Field', 9: 'Constructor', 10: 'Enum',
    11: 'Interface', 12: 'Function', 13: 'Variable', 14: 'Constant',
    15: 'String', 16: 'Number', 17: 'Boolean', 18: 'Array', 19: 'Object',
    20: 'Key', 21: 'Null', 22: 'EnumMember', 23: 'Struct', 24: 'Event',
    25: 'Operator', 26: 'TypeParameter',
  };
  return map[kind] || 'Unknown';
}

function formatDocumentSymbols(symbols: any[], indent: number): string[] {
  const lines: string[] = [];
  for (const s of symbols) {
    const prefix = '  '.repeat(indent);
    lines.push(`${prefix}${s.name} (${kindName(s.kind)}) L${s.range.start.line + 1}`);
    if (s.children) {
      lines.push(...formatDocumentSymbols(s.children, indent + 1));
    }
  }
  return lines;
}
