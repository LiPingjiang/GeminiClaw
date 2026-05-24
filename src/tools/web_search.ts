// src/tools/web_search.ts
// Free web search — no API key required.
// Backends: cn.bing.com (primary, accessible from CN) | baidu.com (fallback, CN-only)
import { registry } from './registry.js'
import { get as httpsGet } from 'https'
import { IncomingMessage } from 'http'

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

function fetchHtml(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = httpsGet(url, {
      headers: {
        'User-Agent': UA,
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        Accept: 'text/html,application/xhtml+xml',
      },
    }, (res: IncomingMessage) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        resolve(fetchHtml(res.headers.location as string))
        return
      }
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')))
    })
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('Request timed out')) })
    req.on('error', reject)
  })
}

/** Strip HTML tags and collapse whitespace. */
function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s{2,}/g, ' ').replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').trim()
}

interface SearchResult {
  title: string
  url: string
  snippet: string
}

/** Parse Bing search results HTML. */
function parseBing(html: string, maxResults: number): SearchResult[] {
  const results: SearchResult[] = []
  // Bing result structure: <li class="b_algo">...<h2><a href="...">title</a></h2><p>snippet</p>
  const liRe = /<li[^>]+class="[^"]*b_algo[^"]*"[^>]*>([\s\S]*?)<\/li>/gi
  let liMatch
  while ((liMatch = liRe.exec(html)) !== null && results.length < maxResults) {
    const block = liMatch[1]
    const hrefMatch = /href="([^"]+)"/.exec(block)
    const titleMatch = /<h2[^>]*>([\s\S]*?)<\/h2>/i.exec(block)
    const snippetMatch = /<p[^>]*>([\s\S]*?)<\/p>/i.exec(block)
    if (!hrefMatch || !titleMatch) continue
    const url = hrefMatch[1]
    if (!url.startsWith('http')) continue
    const title = stripHtml(titleMatch[1]).trim()
    const snippet = snippetMatch ? stripHtml(snippetMatch[1]).trim() : ''
    if (title) results.push({ title, url, snippet })
  }
  return results
}

/** Parse Baidu search results HTML. */
function parseBaidu(html: string, maxResults: number): SearchResult[] {
  const results: SearchResult[] = []
  // Baidu result: <div class="result ..."><h3><a ...>title</a></h3>...<span class="content-right_8Zs40">snippet
  const divRe = /<div[^>]+class="[^"]*result\b[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/gi
  let divMatch
  while ((divMatch = divRe.exec(html)) !== null && results.length < maxResults) {
    const block = divMatch[1]
    const hrefMatch = /href="(https?:\/\/[^"]+)"/.exec(block)
    const titleMatch = /<h3[^>]*>([\s\S]*?)<\/h3>/i.exec(block)
    const snippetMatch = /<[^>]+class="[^"]*content[^"]*"[^>]*>([\s\S]*?)<\/[^>]+>/i.exec(block)
    if (!hrefMatch || !titleMatch) continue
    const title = stripHtml(titleMatch[1]).trim()
    const snippet = snippetMatch ? stripHtml(snippetMatch[1]).trim() : ''
    if (title) results.push({ title, url: hrefMatch[1], snippet })
  }
  return results
}

async function searchBing(query: string, maxResults: number, region: string): Promise<SearchResult[]> {
  const q = encodeURIComponent(query)
  const mkt = region === 'zh-cn' ? 'zh-CN' : 'en-US'
  const url = `https://cn.bing.com/search?q=${q}&mkt=${mkt}&count=${maxResults + 5}`
  const html = await fetchHtml(url)
  return parseBing(html, maxResults)
}

async function searchBaidu(query: string, maxResults: number): Promise<SearchResult[]> {
  const q = encodeURIComponent(query)
  const url = `https://www.baidu.com/s?wd=${q}&rn=${maxResults + 5}`
  const html = await fetchHtml(url)
  return parseBaidu(html, maxResults)
}

async function searchNews(query: string, maxResults: number): Promise<SearchResult[]> {
  const q = encodeURIComponent(query)
  const url = `https://cn.bing.com/news/search?q=${q}&mkt=zh-CN`
  const html = await fetchHtml(url)
  // News card structure: <div class="news-card ..."><a ...>title</a>...<div class="snippet">
  const results: SearchResult[] = []
  const cardRe = /<div[^>]+class="[^"]*news-card\b[^"]*"[^>]*>([\s\S]*?)(?=<div[^>]+class="[^"]*news-card\b|$)/gi
  let m
  while ((m = cardRe.exec(html)) !== null && results.length < maxResults) {
    const block = m[1]
    const href = /href="(https?:\/\/[^"]+)"/.exec(block)?.[1]
    const title = stripHtml(/<a[^>]+class="[^"]*title[^"]*"[^>]*>([\s\S]*?)<\/a>/i.exec(block)?.[1] ?? '').trim()
    const snippet = stripHtml(/<div[^>]+class="[^"]*snippet[^"]*"[^>]*>([\s\S]*?)<\/div>/i.exec(block)?.[1] ?? '').trim()
    if (href && title) results.push({ title, url: href, snippet })
  }
  return results
}

function formatResults(results: SearchResult[]): string {
  if (!results.length) return '未找到相关结果。'
  return results.map((r, i) =>
    `[${i + 1}] ${r.title}\n${r.snippet ? r.snippet + '\n' : ''}URL: ${r.url}`
  ).join('\n\n')
}

registry.register({
  name: 'web_search',
  description: [
    'Search the web. Free, no API key. Uses Bing CN (primary) or Baidu (fallback).',
    'Types: "text" (general web), "news" (recent news), "baidu" (Chinese-focused).',
    'Good for: current events, stock prices, technical docs, general knowledge.',
  ].join(' '),
  schema: {
    type: 'object',
    properties: {
      query:      { type: 'string', description: 'Search query' },
      type:       { type: 'string', enum: ['text', 'news', 'baidu'], description: 'Search type (default: text)' },
      maxResults: { type: 'number', description: 'Max results (default: 8, max: 20)' },
      region:     { type: 'string', description: 'Region: "zh-cn" or "en-us" (default: zh-cn)' },
    },
    required: ['query'],
  },
  handler: async (params) => {
    const query      = params['query'] as string
    const type       = (params['type'] as string) ?? 'text'
    const maxResults = Math.min(Number(params['maxResults'] ?? 8), 20)
    const region     = (params['region'] as string) ?? 'zh-cn'

    try {
      let results: SearchResult[]
      if (type === 'news') {
        results = await searchNews(query, maxResults)
        if (!results.length) results = await searchBing(query + ' 最新', maxResults, region)
      } else if (type === 'baidu') {
        results = await searchBaidu(query, maxResults)
      } else {
        results = await searchBing(query, maxResults, region)
        if (!results.length) results = await searchBaidu(query, maxResults)
      }
      return { type: 'text', text: formatResults(results) }
    } catch (err: any) {
      return { type: 'error', error: `搜索失败: ${err.message}` }
    }
  },
  toolset: ['default'],
  requiresApproval: false,
  executionMode: 'parallel',
})
