// @ts-nocheck
/**
 * repo_map — Aider-style repository map tool
 *
 * Scans TypeScript source files, extracts top-level symbols (functions, classes,
 * interfaces, types) and their signatures, ranks files by import reference count,
 * and returns a compact code-structure map within the requested character budget.
 *
 * No extra runtime dependencies — uses only Node.js built-ins and regex parsing.
 */
import { readFile, readdir, stat } from 'node:fs/promises';
import { join, relative, extname } from 'node:path';
import { registry } from './registry.js';
// ---------------------------------------------------------------------------
// File discovery
// ---------------------------------------------------------------------------
const SKIP_DIRS = new Set([
    'node_modules',
    'dist',
    '.git',
    'coverage',
    '.nyc_output',
    '__pycache__',
    '.cache',
]);
async function findTsFiles(dir) {
    const results = [];
    async function walk(current) {
        let entries;
        try {
            entries = await readdir(current);
        }
        catch {
            return;
        }
        for (const entry of entries) {
            if (SKIP_DIRS.has(entry))
                continue;
            const full = join(current, entry);
            let s;
            try {
                s = await stat(full);
            }
            catch {
                continue;
            }
            if (s.isDirectory()) {
                await walk(full);
            }
            else if (s.isFile() &&
                extname(entry) === '.ts' &&
                !entry.endsWith('.d.ts') &&
                !entry.endsWith('.test.ts') &&
                !entry.endsWith('.spec.ts')) {
                results.push(full);
            }
        }
    }
    await walk(dir);
    return results;
}
// ---------------------------------------------------------------------------
// Symbol extraction (line-by-line regex approach)
// ---------------------------------------------------------------------------
// Matches: export [async] function name(...): ReturnType
const RE_FUNC = /^export\s+(?:async\s+)?function\s+(\w+)\s*(<[^>]*>)?\s*\(([^)]*)\)(?:\s*:\s*([^{;]+))?/;
// Matches: export class Foo [extends/implements ...]
const RE_CLASS = /^export\s+(?:abstract\s+)?class\s+(\w+)(?:\s*<[^>]*>)?(?:\s+extends\s+[^{]+)?(?:\s+implements\s+[^{]+)?/;
// Matches: export interface Foo
const RE_IFACE = /^export\s+interface\s+(\w+)(?:\s*<[^>]*>)?/;
// Matches: export type Foo = ...
const RE_TYPE = /^export\s+type\s+(\w+)(?:\s*<[^>]*>)?\s*=/;
// Matches: export const name = ... (arrow functions, objects)
const RE_CONST = /^export\s+const\s+(\w+)\s*(?::\s*[^=]+)?\s*=/;
// Class member: [modifier] [async] methodName(...): ReturnType
// Must have parentheses to distinguish from properties
const RE_METHOD = /^(?:(public|private|protected|static|async|override|readonly)\s+)*(\w+)\s*(<[^>]*>)?\s*\(([^)]*)\)(?:\s*:\s*([^{;]+))?/;
/** Trim a parameter list to a shorter form if too long */
function shortenParams(params, max = 60) {
    const trimmed = params.trim();
    if (trimmed.length <= max)
        return trimmed;
    // Keep first param only and add ...
    const firstComma = trimmed.indexOf(',');
    if (firstComma === -1)
        return trimmed.slice(0, max) + '…';
    return trimmed.slice(0, firstComma) + ', …';
}
/** Trim a type annotation if too long */
function shortenType(t, max = 40) {
    if (!t)
        return '';
    const trimmed = t.trim().replace(/\s+/g, ' ');
    if (trimmed.length <= max)
        return trimmed;
    return trimmed.slice(0, max) + '…';
}
async function extractSymbols(filePath) {
    let content;
    try {
        content = await readFile(filePath, 'utf8');
    }
    catch {
        return [];
    }
    const lines = content.split('\n');
    const symbols = [];
    let inClass = false;
    let braceDepth = 0;
    let classStartDepth = 0;
    for (let i = 0; i < lines.length; i++) {
        const raw = lines[i];
        const line = raw.trim();
        // Track brace depth
        const openBraces = (raw.match(/{/g) ?? []).length;
        const closeBraces = (raw.match(/}/g) ?? []).length;
        const prevDepth = braceDepth;
        braceDepth += openBraces - closeBraces;
        // Detect class entry/exit
        if (inClass && braceDepth <= classStartDepth) {
            inClass = false;
        }
        // Skip comments and empty lines
        if (line.startsWith('//') || line.startsWith('*') || line.startsWith('/*') || line === '') {
            continue;
        }
        if (!inClass) {
            // Top-level: look for export declarations
            let m;
            m = line.match(RE_FUNC);
            if (m) {
                const name = m[1];
                const params = shortenParams(m[3] ?? '');
                const ret = shortenType(m[4]);
                const isAsync = line.includes('async function') ? 'async ' : '';
                symbols.push({
                    line: `${isAsync}function ${name}(${params})${ret ? ': ' + ret : ''}`,
                    depth: 0,
                });
                continue;
            }
            m = line.match(RE_CLASS);
            if (m) {
                const name = m[1];
                symbols.push({ line: `class ${name}`, depth: 0 });
                inClass = true;
                classStartDepth = prevDepth; // depth before this line's braces
                continue;
            }
            m = line.match(RE_IFACE);
            if (m) {
                symbols.push({ line: `interface ${m[1]}`, depth: 0 });
                continue;
            }
            m = line.match(RE_TYPE);
            if (m) {
                symbols.push({ line: `type ${m[1]}`, depth: 0 });
                continue;
            }
            m = line.match(RE_CONST);
            if (m) {
                // Only show if it's an arrow function or important export
                const rest = line.slice(line.indexOf('=') + 1).trim();
                if (rest.startsWith('(') || rest.startsWith('async') || rest.includes('=>')) {
                    symbols.push({ line: `const ${m[1]}`, depth: 0 });
                }
                continue;
            }
        }
        else {
            // Inside class: extract method signatures
            // Only at depth == classStartDepth + 1
            if (braceDepth !== classStartDepth + 1)
                continue;
            // Skip decorators, property assignments, and common patterns
            if (line.startsWith('@') ||
                line.startsWith('//') ||
                line.startsWith('*') ||
                line === '{' ||
                line === '}') {
                continue;
            }
            // Match method signature (must have parens)
            if (!line.includes('('))
                continue;
            const m = line.match(RE_METHOD);
            if (m) {
                const modifiers = [];
                // Collect modifier keywords
                let tmp = line;
                const MODS = ['public', 'private', 'protected', 'static', 'async', 'override', 'abstract', 'readonly'];
                for (const mod of MODS) {
                    if (new RegExp(`\\b${mod}\\b`).test(tmp))
                        modifiers.push(mod);
                }
                const name = m[2];
                // Skip constructor in display (too common, not informative)
                if (name === 'constructor')
                    continue;
                // Skip getters/setters only shown as prop names
                const params = shortenParams(m[4] ?? '');
                const ret = shortenType(m[5]);
                const prefix = modifiers.filter(x => x !== 'public').join(' ');
                const display = `${prefix ? prefix + ' ' : ''}${name}(${params})${ret ? ': ' + ret : ''}`;
                symbols.push({ line: display.trim(), depth: 1 });
            }
        }
    }
    return symbols;
}
// ---------------------------------------------------------------------------
// Reference counting (import graph)
// ---------------------------------------------------------------------------
/** Parse import statements to collect imported file base names */
function parseImports(content) {
    // Match: import ... from './path' or import ... from "../path"
    const RE_IMPORT = /from\s+['"]([^'"]+)['"]/g;
    const results = [];
    let m;
    while ((m = RE_IMPORT.exec(content)) !== null) {
        const spec = m[1];
        // Only relative imports
        if (spec.startsWith('.')) {
            results.push(spec);
        }
    }
    return results;
}
async function buildReferenceMap(files, rootDir) {
    const refCount = new Map();
    for (const f of files)
        refCount.set(f, 0);
    for (const f of files) {
        let content;
        try {
            content = await readFile(f, 'utf8');
        }
        catch {
            continue;
        }
        const imports = parseImports(content);
        const fileDir = f.slice(0, f.lastIndexOf('/'));
        for (const imp of imports) {
            // Resolve relative import path to absolute
            let resolved = join(fileDir, imp);
            // Try with and without .ts extension
            const candidates = [resolved + '.ts', resolved + '/index.ts', resolved];
            for (const c of candidates) {
                if (refCount.has(c)) {
                    refCount.set(c, (refCount.get(c) ?? 0) + 1);
                    break;
                }
            }
        }
    }
    return refCount;
}
// ---------------------------------------------------------------------------
// Repo map builder
// ---------------------------------------------------------------------------
export async function buildRepoMap(rootDir, maxChars = 2000) {
    const files = await findTsFiles(rootDir);
    if (files.length === 0) {
        return `(no TypeScript files found in ${rootDir})`;
    }
    // Extract symbols for all files in parallel (batched)
    const BATCH = 20;
    const symbolsMap = new Map();
    for (let i = 0; i < files.length; i += BATCH) {
        const batch = files.slice(i, i + BATCH);
        const results = await Promise.all(batch.map(f => extractSymbols(f)));
        batch.forEach((f, idx) => symbolsMap.set(f, results[idx]));
    }
    // Count references
    const refCount = await buildReferenceMap(files, rootDir);
    // Build FileSymbols list, skip files with no symbols
    const fileInfos = [];
    for (const f of files) {
        const symbols = symbolsMap.get(f) ?? [];
        if (symbols.length === 0)
            continue;
        fileInfos.push({
            relPath: relative(rootDir, f),
            symbols,
            refCount: refCount.get(f) ?? 0,
        });
    }
    // Sort: by refCount desc, then alphabetically
    fileInfos.sort((a, b) => {
        if (b.refCount !== a.refCount)
            return b.refCount - a.refCount;
        return a.relPath.localeCompare(b.relPath);
    });
    // Render within budget
    const lines = [];
    let chars = 0;
    const HEADER = `# Repo Map — ${rootDir}\n# ${fileInfos.length} files, ${files.length} total\n\n`;
    chars += HEADER.length;
    for (const fi of fileInfos) {
        const fileHeader = `${fi.relPath}:\n`;
        const symLines = fi.symbols.map(s => {
            const indent = s.depth === 1 ? '  ' : '';
            return `│${indent}${s.line}\n`;
        });
        const block = fileHeader + symLines.join('') + '│\n';
        if (chars + block.length > maxChars && lines.length > 0) {
            // Try to fit the file header + first few symbols
            const remaining = maxChars - chars - fileHeader.length - 5;
            if (remaining < 20) {
                lines.push(`\n... (${fileInfos.length - lines.length} more files omitted)\n`);
                break;
            }
            // Partial: show header + as many symbols as fit
            let partial = fileHeader;
            let partialChars = fileHeader.length;
            for (const sl of symLines) {
                if (partialChars + sl.length > remaining)
                    break;
                partial += sl;
                partialChars += sl.length;
            }
            lines.push(partial);
            chars += partial.length;
            break;
        }
        lines.push(block);
        chars += block.length;
    }
    return HEADER + lines.join('');
}
// ---------------------------------------------------------------------------
// Tool handler
// ---------------------------------------------------------------------------
async function repoMapHandler(params, ctx) {
    const rawPath = params['path'];
    const targetPath = rawPath ?? ctx.workdir;
    const maxChars = params['maxChars'] ?? 2000;
    try {
        const s = await stat(targetPath);
        if (!s.isDirectory()) {
            return { type: 'error', error: `Path is not a directory: ${targetPath}` };
        }
    }
    catch {
        return { type: 'error', error: `Directory not found: ${targetPath}` };
    }
    try {
        const map = await buildRepoMap(targetPath, maxChars);
        return { type: 'text', text: map };
    }
    catch (err) {
        return { type: 'error', error: `repo_map failed: ${err.message}` };
    }
}
registry.register({
    name: 'repo_map',
    description: 'Generate an Aider-style repository map: scans TypeScript source files, extracts top-level symbols ' +
        '(functions, classes, interfaces, types and their signatures), ranks files by import reference count, ' +
        'and returns a compact code-structure map within the character budget. ' +
        'Call this first when you need to understand the structure of a TypeScript project.',
    schema: {
        type: 'object',
        properties: {
            path: {
                type: 'string',
                description: 'Root directory of the project to map (defaults to session workdir)',
            },
            maxChars: {
                type: 'number',
                description: 'Maximum character budget for the output (default 2000)',
            },
        },
        required: [],
    },
    handler: repoMapHandler,
    toolset: ['default'],
    requiresApproval: false,
    executionMode: 'parallel',
});
