// @ts-nocheck
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { registry } from './registry.js';
async function writeHandler(params, _ctx) {
    const filePath = params['path'];
    const content = params['content'];
    try {
        await mkdir(dirname(filePath), { recursive: true });
    }
    catch (err) {
        return { type: 'error', error: `Failed to create directories: ${err.message}` };
    }
    try {
        await writeFile(filePath, content, 'utf8');
        return { type: 'text', text: `Successfully wrote ${content.length} bytes to ${filePath}` };
    }
    catch (err) {
        return { type: 'error', error: `Failed to write file: ${err.message}` };
    }
}
registry.register({
    name: 'write',
    description: 'Write content to a file, creating parent directories as needed',
    schema: {
        type: 'object',
        properties: {
            path: { type: 'string', description: 'Path to the file to write' },
            content: { type: 'string', description: 'Content to write to the file' },
        },
        required: ['path', 'content'],
    },
    handler: writeHandler,
    toolset: ['default'],
    requiresApproval: true,
    executionMode: 'sequential',
});
