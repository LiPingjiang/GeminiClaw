// src/tools/web_search.ts
// Free web search via duck-duck-scrape — no API key required
import { registry } from './registry.js'

type SearchResult = {
  title: string
  url: string
  description: string
}

type NewsResult = {
  title: string
  url: string
  excerpt: string
  source: string
  date?: string
}

async function ddgSearch(query: string, type: string, maxResults: number, region: string): Promise<string> {
  let ddg: typeof import('duck-duck-scrape')
  try {
    ddg = await import('duck-duck-scrape')
  } catch {
    return 'Error: duck-duck-scrape not installed. Run: pnpm add duck-duck-scrape'
  }

  try {
    if (type === 'news') {
      const raw = await ddg.searchNews(query, {
        safeSearch: ddg.SafeSearchType.OFF,
        locale: region,
      })
      const results: NewsResult[] = (raw.results ?? []).slice(0, maxResults).map((r: any) => ({
        title: r.title,
        url: r.url,
        excerpt: r.excerpt ?? '',
        source: r.source ?? '',
        date: r.date ? new Date(r.date).toLocaleDateString('zh-CN') : undefined,
      }))
      if (!results.length) return '未找到相关新闻。'
      return results.map((r, i) =>
        `[${i + 1}] ${r.title}\n来源: ${r.source}${r.date ? ' · ' + r.date : ''}\n摘要: ${r.excerpt}\nURL: ${r.url}`
      ).join('\n\n')
    } else {
      const raw = await ddg.search(query, {
        safeSearch: ddg.SafeSearchType.OFF,
        locale: region,
      })
      const results: SearchResult[] = (raw.results ?? []).slice(0, maxResults).map((r: any) => ({
        title: r.title,
        url: r.url,
        description: r.description ?? '',
      }))
      if (!results.length) return '未找到相关结果。'
      return results.map((r, i) =>
        `[${i + 1}] ${r.title}\n${r.description}\nURL: ${r.url}`
      ).join('\n\n')
    }
  } catch (err: any) {
    return `搜索失败: ${err.message}`
  }
}

registry.register({
  name: 'web_search',
  description: 'Search the web using DuckDuckGo. Free, no API key required. Supports text and news search.',
  schema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Search query',
      },
      type: {
        type: 'string',
        enum: ['text', 'news'],
        description: 'Search type: "text" for general web search, "news" for recent news (default: text)',
      },
      maxResults: {
        type: 'number',
        description: 'Maximum number of results to return (default: 8, max: 20)',
      },
      region: {
        type: 'string',
        description: 'Search region locale, e.g. "zh-cn" for Chinese results, "us-en" for English (default: zh-cn)',
      },
    },
    required: ['query'],
  },
  handler: async (params) => {
    const query = params['query'] as string
    const type = (params['type'] as string) ?? 'text'
    const maxResults = Math.min(Number(params['maxResults'] ?? 8), 20)
    const region = (params['region'] as string) ?? 'zh-cn'
    const result = await ddgSearch(query, type, maxResults, region)
    return { type: 'text', text: result }
  },
  toolset: ['default'],
  requiresApproval: false,
  executionMode: 'parallel',
})
