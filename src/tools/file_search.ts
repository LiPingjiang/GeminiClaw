// @ts-nocheck
import { registry } from './registry.js';
import { getFileIndex } from './file-index/index.js';

/**
 * file_search — 模糊文件搜索
 * 使用 FileIndex（位图预过滤 + fzf 评分）快速定位文件。
 */
registry.register({
  name: 'file_search',
  description: 'Fuzzy search for files in the workspace. Returns top matching file paths ranked by relevance.',
  schema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Fuzzy query string to match file paths (e.g. "app tui" matches src/cli/tui/app.tsx)',
      },
      limit: {
        type: 'number',
        description: 'Maximum number of results to return (default 20)',
      },
    },
    required: ['query'],
  },
  handler: async (params, ctx) => {
    const query = String(params.query || '');
    const limit = Number(params.limit || 20);
    const index = getFileIndex();
    if (!index.isReady) {
      return { type: 'error' as const, error: 'File index not initialized. Run repo_index first.' };
    }
    const results = index.search(query, limit);
    const lines = results.map(r => `${r.path} (score: ${r.score})`);
    return { type: 'text' as const, text: lines.join('\n') || 'No matches found.' };
  },
});

/**
 * repo_index — 构建文件索引
 * 扫描工作目录，构建 FileIndex 供 file_search 使用。
 */
registry.register({
  name: 'repo_index',
  description: 'Build or rebuild the fuzzy file index for the workspace. Call this once before using file_search.',
  schema: {
    type: 'object',
    properties: {
      workdir: {
        type: 'string',
        description: 'Workspace directory to index (default: current working directory)',
      },
    },
  },
  handler: async (params, ctx) => {
    const { execSync } = await import('node:child_process');
    const workdir = String(params.workdir || ctx.workdir);
    try {
      const output = execSync('git ls-files', { cwd: workdir, encoding: 'utf-8', maxBuffer: 50 * 1024 * 1024 });
      const files = output.split('\n').filter(Boolean);
      getFileIndex().loadFromFileList(files);
      return { type: 'text' as const, text: `Indexed ${files.length} files.` };
    } catch {
      // fallback to find
      try {
        const output = execSync('find . -type f -not -path "*/node_modules/*" -not -path "*/.git/*" -not -path "*/dist/*"', {
          cwd: workdir, encoding: 'utf-8', maxBuffer: 50 * 1024 * 1024,
        });
        const files = output.split('\n').filter(Boolean).map(f => f.replace(/^\.\//, ''));
        getFileIndex().loadFromFileList(files);
        return { type: 'text' as const, text: `Indexed ${files.length} files (fallback mode).` };
      } catch (err: any) {
        return { type: 'error' as const, error: `Failed to index: ${err.message}` };
      }
    }
  },
});
