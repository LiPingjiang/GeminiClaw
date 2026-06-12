// @ts-nocheck
import { spawn } from 'node:child_process';
import { registry } from './registry.js';
const IGNORED_DIRS = ['node_modules', '.git', 'dist'];
async function checkRgAvailable() {
    return new Promise(resolve => {
        const proc = spawn('rg', ['--version'], { stdio: 'ignore' });
        proc.on('close', code => resolve(code === 0));
        proc.on('error', () => resolve(false));
    });
}
async function grepHandler(params, ctx) {
    const pattern = params['pattern'];
    const searchPath = params['path'] ?? ctx.workdir;
    const include = params['include'];
    const maxResults = params['maxResults'] ?? 50;
    const useRg = await checkRgAvailable();
    return new Promise(resolve => {
        let args;
        if (useRg) {
            // ripgrep args
            args = [
                '--line-number',
                '--no-heading',
                '--color', 'never',
                '--max-count', String(maxResults + 1), // fetch one extra to detect truncation
            ];
            for (const dir of IGNORED_DIRS) {
                args.push('--glob', `!${dir}/**`);
            }
            if (include) {
                args.push('--glob', include);
            }
            args.push(pattern, searchPath);
        }
        else {
            // grep -rn fallback
            args = ['-r', '-n', '--color=never'];
            for (const dir of IGNORED_DIRS) {
                args.push('--exclude-dir', dir);
            }
            if (include) {
                args.push('--include', include);
            }
            args.push(pattern, searchPath);
        }
        const cmd = useRg ? 'rg' : 'grep';
        let stdout = '';
        let stderr = '';
        let killed = false;
        const TIMEOUT_MS = 30_000; // 30 seconds
        const proc = spawn(cmd, args, { env: process.env });
        const timer = setTimeout(() => {
            killed = true;
            proc.kill('SIGTERM');
        }, TIMEOUT_MS);
        proc.stdout.on('data', (chunk) => {
            stdout += chunk.toString();
        });
        proc.stderr.on('data', (chunk) => {
            stderr += chunk.toString();
        });
        proc.on('close', (code) => {
            clearTimeout(timer);
            if (killed) {
                const partial = stdout.split('\n').filter(l => l.trim()).slice(0, maxResults).join('\n');
                resolve({ type: 'error', error: `Search timed out after ${TIMEOUT_MS / 1000}s.\n${partial ? 'Partial results:\n' + partial : ''}` });
                return;
            }
            // rg: exit 1 = no match (not an error), exit 2 = real error
            // grep: exit 1 = no match, exit 2 = real error
            if (code === 1) {
                resolve({ type: 'text', text: '（无匹配结果）' });
                return;
            }
            if (code !== 0 && code !== null) {
                const errMsg = stderr.trim() || `Exit code ${code}`;
                resolve({ type: 'error', error: errMsg });
                return;
            }
            const lines = stdout.split('\n').filter(l => l.trim() !== '');
            let truncated = false;
            let result = lines;
            if (lines.length > maxResults) {
                result = lines.slice(0, maxResults);
                truncated = true;
            }
            const output = result.join('\n');
            const suffix = truncated
                ? `\n\n（结果已截断，仅显示前 ${maxResults} 条，共约 ${lines.length} 条）`
                : '';
            resolve({ type: 'text', text: output + suffix });
        });
        proc.on('error', (err) => {
            clearTimeout(timer);
            resolve({ type: 'error', error: `Failed to spawn ${cmd}: ${err.message}` });
        });
    });
}
registry.register({
    name: 'grep',
    description: 'Search for a pattern (regex or literal string) in files using ripgrep (rg) or grep. Returns matching lines with file name and line number.',
    schema: {
        type: 'object',
        properties: {
            pattern: {
                type: 'string',
                description: 'Search pattern (supports regex). Example: "function\\s+myFunc" or "TODO"',
            },
            path: {
                type: 'string',
                description: 'Directory to search in (default: current working directory)',
            },
            include: {
                type: 'string',
                description: 'Glob pattern to filter file types. Example: "*.ts" or "*.{js,ts}"',
            },
            maxResults: {
                type: 'number',
                description: 'Maximum number of results to return (default: 50)',
            },
        },
        required: ['pattern'],
    },
    handler: grepHandler,
    toolset: ['default'],
    requiresApproval: false,
    executionMode: 'parallel',
});
