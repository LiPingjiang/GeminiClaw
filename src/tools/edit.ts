// @ts-nocheck
import { readFile, writeFile } from 'node:fs/promises';
import { registry } from './registry.js';
import { fuzzyFindAndReplace } from './fuzzy_edit.js';
async function editHandler(params, _ctx) {
    const filePath = params['path'];
    const edits = params['edits'];
    let content;
    try {
        content = await readFile(filePath, 'utf8');
    }
    catch (err) {
        return { type: 'error', error: `Failed to read file: ${err.message}` };
    }
    let current = content;
    for (const edit of edits) {
        const { oldText, newText } = edit;
        // ── Fast path: exact match ──────────────────────────────────────────────
        const firstIdx = current.indexOf(oldText);
        if (firstIdx !== -1) {
            // Verify uniqueness
            const secondIdx = current.indexOf(oldText, firstIdx + 1);
            if (secondIdx !== -1) {
                return {
                    type: 'error',
                    error: `Text appears multiple times in file (must be unique): ${JSON.stringify(oldText.slice(0, 80))}`,
                };
            }
            current = current.slice(0, firstIdx) + newText + current.slice(firstIdx + oldText.length);
            continue;
        }
        // ── Fallback: 8-strategy fuzzy match ───────────────────────────────────
        const fuzzy = fuzzyFindAndReplace(current, oldText, newText, false);
        if (!fuzzy.success) {
            if (fuzzy.matchCount > 1) {
                return {
                    type: 'error',
                    error: `Text appears ${fuzzy.matchCount} times via fuzzy matching (strategy: ${fuzzy.strategy}). ` +
                        `Provide more context to make oldText unique: ${JSON.stringify(oldText.slice(0, 80))}`,
                };
            }
            return {
                type: 'error',
                error: `Text not found in file (tried 8 fuzzy strategies): ${JSON.stringify(oldText.slice(0, 80))}`,
            };
        }
        // Fuzzy match succeeded — log which strategy was used and apply result
        current = fuzzy.result;
        edit._strategy = fuzzy.strategy;
    }
    try {
        await writeFile(filePath, current, 'utf8');
        // Summarise which strategies were used across all edits
        const strategyNotes = edits
            .map((e) => e._strategy)
            .filter(Boolean);
        const note = strategyNotes.length > 0
            ? ` (fuzzy strategies used: ${[...new Set(strategyNotes)].join(', ')})`
            : '';
        return {
            type: 'text',
            text: `Successfully applied ${edits.length} edit(s) to ${filePath}${note}`,
        };
    }
    catch (err) {
        return { type: 'error', error: `Failed to write file: ${err.message}` };
    }
}
registry.register({
    name: 'edit',
    description: 'Apply precise text replacements to a file',
    schema: {
        type: 'object',
        properties: {
            path: { type: 'string', description: 'Path to the file to edit' },
            edits: {
                type: 'array',
                description: 'List of text replacements to apply',
                items: {
                    type: 'object',
                    properties: {
                        oldText: { type: 'string', description: 'Exact text to replace (must be unique in file)' },
                        newText: { type: 'string', description: 'Replacement text' },
                    },
                    required: ['oldText', 'newText'],
                },
            },
        },
        required: ['path', 'edits'],
    },
    handler: editHandler,
    toolset: ['default'],
    requiresApproval: true,
    executionMode: 'sequential',
});
