// @ts-nocheck
import { readFile, stat } from 'node:fs/promises';
import { registry } from './registry.js';
const MAX_LINES = 2000;
const MAX_BYTES = 50 * 1024; // 50KB
async function readHandler(params, _ctx) {
    const filePath = params['path'];
    const offset = params['offset'] ?? 1;
    const limit = params['limit'];
    try {
        const stats = await stat(filePath);
        if (stats.isDirectory()) {
            return { type: 'error', error: `Path is a directory: ${filePath}` };
        }
    }
    catch (err) {
        return { type: 'error', error: `File not found: ${filePath}` };
    }
    let content;
    try {
        const buffer = await readFile(filePath);
        if (buffer.length > MAX_BYTES) {
            content = buffer.slice(0, MAX_BYTES).toString('utf8');
            const lines = content.split('\n');
            return {
                type: 'text',
                text: lines.join('\n') + `\n...[truncated: file exceeds ${MAX_BYTES} bytes]`,
            };
        }
        content = buffer.toString('utf8');
    }
    catch (err) {
        return { type: 'error', error: `Failed to read file: ${err.message}` };
    }
    const lines = content.split('\n');
    const totalLines = lines.length;
    // offset is 1-indexed
    const startIdx = Math.max(0, offset - 1);
    const endIdx = limit !== undefined ? startIdx + limit : totalLines;
    const selectedLines = lines.slice(startIdx, endIdx);
    let truncated = false;
    let resultLines = selectedLines;
    if (resultLines.length > MAX_LINES) {
        resultLines = resultLines.slice(0, MAX_LINES);
        truncated = true;
    }
    let text = resultLines.join('\n');
    if (truncated) {
        text += `\n...[truncated: showing ${MAX_LINES} of ${selectedLines.length} lines]`;
    }
    return { type: 'text', text };
}
registry.register({
    name: 'read',
    description: 'Read the contents of a file',
    schema: {
        type: 'object',
        properties: {
            path: { type: 'string', description: 'Path to the file to read' },
            offset: { type: 'number', description: 'Starting line number (1-indexed, default 1)' },
            limit: { type: 'number', description: 'Maximum number of lines to return' },
        },
        required: ['path'],
    },
    handler: readHandler,
    toolset: ['default'],
    requiresApproval: false,
    executionMode: 'parallel',
});
