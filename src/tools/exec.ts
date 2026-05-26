// @ts-nocheck
import { spawn } from 'node:child_process';
import { registry } from './registry.js';
const MAX_OUTPUT_CHARS = 8000;
const HEAD_TAIL_CHARS = 2000;
function truncateOutput(output) {
    if (output.length <= MAX_OUTPUT_CHARS)
        return output;
    const head = output.slice(0, HEAD_TAIL_CHARS);
    const tail = output.slice(-HEAD_TAIL_CHARS);
    return `${head}\n...[truncated]...\n${tail}`;
}
async function execHandler(params, ctx) {
    const command = params['command'];
    const timeoutSecs = params['timeout'] ?? 30;
    const workdir = params['workdir'] ?? ctx.workdir;
    return new Promise(resolve => {
        let stdout = '';
        let stderr = '';
        let timedOut = false;
        const proc = spawn('sh', ['-c', command], {
            cwd: workdir,
            env: process.env,
        });
        const timer = setTimeout(() => {
            timedOut = true;
            proc.kill('SIGTERM');
            resolve({ type: 'error', error: `Command timed out after ${timeoutSecs}s` });
        }, timeoutSecs * 1000);
        proc.stdout.on('data', (chunk) => {
            stdout += chunk.toString();
        });
        proc.stderr.on('data', (chunk) => {
            stderr += chunk.toString();
        });
        proc.on('close', (code) => {
            if (timedOut)
                return;
            clearTimeout(timer);
            const combined = stdout + (stderr ? `\nSTDERR:\n${stderr}` : '');
            const output = truncateOutput(combined);
            if (code !== 0) {
                resolve({ type: 'error', error: `Exit code ${code ?? 'null'}: ${output}` });
            }
            else {
                resolve({ type: 'text', text: output });
            }
        });
        proc.on('error', (err) => {
            if (timedOut)
                return;
            clearTimeout(timer);
            resolve({ type: 'error', error: `Failed to spawn process: ${err.message}` });
        });
    });
}
registry.register({
    name: 'exec',
    description: 'Execute a shell command and return its output',
    schema: {
        type: 'object',
        properties: {
            command: { type: 'string', description: 'Shell command to execute' },
            timeout: { type: 'number', description: 'Timeout in seconds (default 30)' },
            workdir: { type: 'string', description: 'Working directory for the command' },
        },
        required: ['command'],
    },
    handler: execHandler,
    toolset: ['default'],
    requiresApproval: true,
    executionMode: 'sequential',
});
