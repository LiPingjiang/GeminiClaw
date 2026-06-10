// src/tools/web_search.ts
// Free web search — no API key required.
// Backends: cn.bing.com (primary, accessible from CN) | baidu.com (fallback, CN-only)
import { registry } from './registry.js';
import { get as httpsGet, request as httpsRequest } from 'https';
import { request as httpRequest } from 'http';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

function fetchHtml(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const isHttps = url.startsWith('https');
    const doRequest = isHttps ? httpsGet : (httpRequest as any);
    const req = doRequest(url, {
      headers: {
        'User-Agent': UA,
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Encoding': 'identity',
        Connection: 'keep-alive',
        'Cache-Control': 'no-cache',
      },
    }, (res: any) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const location = res.headers.location;
        // Handle relative redirects
        const redirectUrl = location.startsWith('http') ? location : new URL(location, url).toString();
        resolve(fetchHtml(redirectUrl));
        return;
      }
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    });
    req.setTimeout(12000, () => { req.destroy(); reject(new Error('Request timed out')); });
    req.on('error', reject);
    if (!isHttps) req.end();
  });
}

/** Strip HTML tags and collapse whitespace. */
function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#\d+;/g, ' ')
    .replace(/&ensp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .trim();
}

/** Validate that a URL looks like a real search result (not a resource/tracking URL). */
function isValidResultUrl(url: string): boolean {
  if (!url.startsWith('http')) return false;
  // Reject obvious non-result URLs: CSS, JS, images, tracking pixels, Bing internal resources
  const junkPatterns = [
    /\.css(\?|$)/i,
    /\.js(\?|$)/i,
    /\.png(\?|$)/i,
    /\.gif(\?|$)/i,
    /\.ico(\?|$)/i,
    /\/rs\/\w+\//i,          // Bing resource paths like /rs/4e/bP/
    /r\.bing\.com/i,         // Bing resource domain
    /bing\.com\/ck\//i,      // Bing click tracking
    /bing\.com\/aclick/i,    // Bing ad clicks
    /^https?:\/\/[^/]+$/,    // bare domain with no path (often noise)
  ];
  return !junkPatterns.some(p => p.test(url));
}

/** Check if results look like garbage (all pointing to same domain, or all snippets empty). */
function resultsLookValid(results: Array<{ title: string; url: string; snippet: string }>): boolean {
  if (results.length === 0) return false;
  // If all URLs have the same hostname, suspicious
  const hosts = new Set(results.map(r => {
    try { return new URL(r.url).hostname; } catch { return r.url; }
  }));
  if (hosts.size === 1 && results.length >= 3) return false;
  // If more than 80% have empty snippets and titles under 10 chars, suspicious
  const poor = results.filter(r => !r.snippet && r.title.length < 10);
  if (poor.length > results.length * 0.8) return false;
  return true;
}

// ══════════════════════════════════════════════════════════════════════════════
// Bing parser — multiple strategies for different HTML layouts
// ══════════════════════════════════════════════════════════════════════════════

/** Strategy 1: Classic <li class="b_algo"> structure */
function parseBingClassic(html: string, maxResults: number): Array<{ title: string; url: string; snippet: string }> {
  const results: Array<{ title: string; url: string; snippet: string }> = [];
  const liRe = /<li[^>]+class="[^"]*b_algo[^"]*"[^>]*>([\s\S]*?)<\/li>/gi;
  let liMatch;
  while ((liMatch = liRe.exec(html)) !== null && results.length < maxResults) {
    const block = liMatch[1];
    // Get the FIRST <a> inside <h2> — this is the real result link
    const h2AMatch = /<h2[^>]*>[\s\S]*?<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(block);
    const snippetMatch = /<p[^>]*>([\s\S]*?)<\/p>/i.exec(block)
      ?? /<div[^>]+class="[^"]*b_caption[^"]*"[^>]*>[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/i.exec(block);

    if (!h2AMatch) continue;
    const url = h2AMatch[1];
    if (!isValidResultUrl(url)) continue;
    const title = stripHtml(h2AMatch[2]).trim();
    const snippet = snippetMatch ? stripHtml(snippetMatch[1]).trim() : '';
    if (title) results.push({ title, url, snippet });
  }
  return results;
}

/** Strategy 2: Extract from <cite> tags which contain the actual URLs */
function parseBingCite(html: string, maxResults: number): Array<{ title: string; url: string; snippet: string }> {
  const results: Array<{ title: string; url: string; snippet: string }> = [];
  // Some Bing layouts put real URLs in <cite> elements
  const blockRe = /<li[^>]+class="[^"]*b_algo[^"]*"[^>]*>([\s\S]*?)<\/li>/gi;
  let match;
  while ((match = blockRe.exec(html)) !== null && results.length < maxResults) {
    const block = match[1];
    // Try to get URL from <cite>
    const citeMatch = /<cite[^>]*>([\s\S]*?)<\/cite>/i.exec(block);
    // Also try regular href
    const hrefMatch = /<a[^>]+href="(https?:\/\/[^"]+)"[^>]*>/i.exec(block);
    const titleMatch = /<h2[^>]*>([\s\S]*?)<\/h2>/i.exec(block);
    const snippetMatch = /<p[^>]*>([\s\S]*?)<\/p>/i.exec(block);

    let url = '';
    if (hrefMatch && isValidResultUrl(hrefMatch[1])) {
      url = hrefMatch[1];
    } else if (citeMatch) {
      const citeText = stripHtml(citeMatch[1]).trim();
      if (citeText.startsWith('http')) url = citeText;
      else if (citeText.match(/^[\w-]+\.\w+/)) url = 'https://' + citeText.split(/\s/)[0];
    }

    if (!url || !titleMatch) continue;
    if (!isValidResultUrl(url)) continue;
    const title = stripHtml(titleMatch[1]).trim();
    const snippet = snippetMatch ? stripHtml(snippetMatch[1]).trim() : '';
    if (title) results.push({ title, url, snippet });
  }
  return results;
}

/** Strategy 3: Fallback — extract ALL <a href="http..."> with nearby text content */
function parseBingFallback(html: string, maxResults: number): Array<{ title: string; url: string; snippet: string }> {
  const results: Array<{ title: string; url: string; snippet: string }> = [];
  const seen = new Set<string>();
  // Find all links that look like search results
  const linkRe = /<a[^>]+href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = linkRe.exec(html)) !== null && results.length < maxResults) {
    const url = m[1];
    if (!isValidResultUrl(url)) continue;
    // Skip Bing internal links
    if (url.includes('bing.com') || url.includes('microsoft.com') || url.includes('msn.com')) continue;
    const hostname = (() => { try { return new URL(url).hostname; } catch { return ''; } })();
    if (seen.has(hostname)) continue; // One result per domain in fallback mode
    seen.add(hostname);
    const title = stripHtml(m[2]).trim();
    if (!title || title.length < 3) continue;
    results.push({ title, url, snippet: '' });
  }
  return results;
}

function parseBing(html: string, maxResults: number): Array<{ title: string; url: string; snippet: string }> {
  // Try strategies in order of reliability
  let results = parseBingClassic(html, maxResults);
  if (resultsLookValid(results)) return results;

  results = parseBingCite(html, maxResults);
  if (resultsLookValid(results)) return results;

  results = parseBingFallback(html, maxResults);
  if (results.length > 0) return results;

  return [];
}

// ══════════════════════════════════════════════════════════════════════════════
// Baidu parser
// ══════════════════════════════════════════════════════════════════════════════

function parseBaidu(html: string, maxResults: number): Array<{ title: string; url: string; snippet: string }> {
  const results: Array<{ title: string; url: string; snippet: string }> = [];

  // Strategy 1: Classic Baidu result divs
  const divRe = /<div[^>]+class="[^"]*(?:result\b|c-container)[^"]*"[^>]*>([\s\S]*?)<\/div>\s*(?=<div[^>]+class="[^"]*(?:result\b|c-container)|\s*$)/gi;
  let divMatch;
  while ((divMatch = divRe.exec(html)) !== null && results.length < maxResults) {
    const block = divMatch[1];
    const hrefMatch = /<a[^>]+href="(https?:\/\/[^"]+)"[^>]*>/i.exec(block);
    const titleMatch = /<h3[^>]*>([\s\S]*?)<\/h3>/i.exec(block);
    const snippetMatch = /<span[^>]+class="[^"]*content[^"]*"[^>]*>([\s\S]*?)<\/span>/i.exec(block)
      ?? /<p[^>]+class="[^"]*content[^"]*"[^>]*>([\s\S]*?)<\/p>/i.exec(block)
      ?? /<div[^>]+class="[^"]*content[^"]*"[^>]*>([\s\S]*?)<\/div>/i.exec(block);

    if (!hrefMatch || !titleMatch) continue;
    const url = hrefMatch[1];
    if (!isValidResultUrl(url)) continue;
    const title = stripHtml(titleMatch[1]).trim();
    const snippet = snippetMatch ? stripHtml(snippetMatch[1]).trim() : '';
    if (title) results.push({ title, url, snippet });
  }

  // Strategy 2: If classic fails, try h3 + a pattern
  if (results.length === 0) {
    const h3Re = /<h3[^>]*>[\s\S]*?<a[^>]+href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<\/h3>/gi;
    let h3Match;
    while ((h3Match = h3Re.exec(html)) !== null && results.length < maxResults) {
      const url = h3Match[1];
      if (!isValidResultUrl(url)) continue;
      if (url.includes('baidu.com') && !url.includes('baike.baidu.com') && !url.includes('zhidao.baidu.com')) continue;
      const title = stripHtml(h3Match[2]).trim();
      if (title && title.length > 2) results.push({ title, url, snippet: '' });
    }
  }

  return results;
}

// ══════════════════════════════════════════════════════════════════════════════
// Search backends
// ══════════════════════════════════════════════════════════════════════════════

async function searchBing(query: string, maxResults: number, region: string): Promise<Array<{ title: string; url: string; snippet: string }>> {
  const q = encodeURIComponent(query);
  const mkt = region === 'zh-cn' ? 'zh-CN' : 'en-US';
  // Try international Bing first (less aggressive blocking), fallback to cn.bing.com
  const urls = [
    `https://www.bing.com/search?q=${q}&setmkt=${mkt}&count=${maxResults + 5}&FORM=QBLH`,
    `https://cn.bing.com/search?q=${q}&mkt=${mkt}&count=${maxResults + 5}`,
  ];

  for (const url of urls) {
    try {
      const html = await fetchHtml(url);
      const results = parseBing(html, maxResults);
      if (resultsLookValid(results)) return results;
    } catch {
      // try next URL
    }
  }
  return [];
}

async function searchBaidu(query: string, maxResults: number): Promise<Array<{ title: string; url: string; snippet: string }>> {
  const q = encodeURIComponent(query);
  const url = `https://www.baidu.com/s?wd=${q}&rn=${maxResults + 5}&ie=utf-8`;
  const html = await fetchHtml(url);
  return parseBaidu(html, maxResults);
}

async function searchNews(query: string, maxResults: number): Promise<Array<{ title: string; url: string; snippet: string }>> {
  const q = encodeURIComponent(query);
  const url = `https://cn.bing.com/news/search?q=${q}&mkt=zh-CN`;
  const html = await fetchHtml(url);
  const results: Array<{ title: string; url: string; snippet: string }> = [];

  // News card structure: <div class="news-card ..."><a ...>title</a>...<div class="snippet">
  const cardRe = /<div[^>]+class="[^"]*news-card\b[^"]*"[^>]*>([\s\S]*?)(?=<div[^>]+class="[^"]*news-card\b|$)/gi;
  let m;
  while ((m = cardRe.exec(html)) !== null && results.length < maxResults) {
    const block = m[1];
    const href = /href="(https?:\/\/[^"]+)"/.exec(block)?.[1];
    const title = stripHtml(/<a[^>]+class="[^"]*title[^"]*"[^>]*>([\s\S]*?)<\/a>/i.exec(block)?.[1] ?? '').trim();
    const snippet = stripHtml(/<div[^>]+class="[^"]*snippet[^"]*"[^>]*>([\s\S]*?)<\/div>/i.exec(block)?.[1] ?? '').trim();
    if (href && title && isValidResultUrl(href)) results.push({ title, url: href, snippet });
  }

  // Fallback: try card-with-title-link pattern
  if (results.length === 0) {
    const altRe = /<a[^>]+class="[^"]*title[^"]*"[^>]+href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
    let am;
    while ((am = altRe.exec(html)) !== null && results.length < maxResults) {
      if (!isValidResultUrl(am[1])) continue;
      const title = stripHtml(am[2]).trim();
      if (title) results.push({ title, url: am[1], snippet: '' });
    }
  }

  return results;
}

function formatResults(results: Array<{ title: string; url: string; snippet: string }>): string {
  if (!results.length) return '未找到相关结果。';
  return results.map((r, i) => `[${i + 1}] ${r.title}\n${r.snippet ? r.snippet + '\n' : ''}URL: ${r.url}`).join('\n\n');
}

// ══════════════════════════════════════════════════════════════════════════════
// Tool registration
// ══════════════════════════════════════════════════════════════════════════════

registry.register({
  name: 'web_search',
  description: [
    'Search the web. Free, no API key. Uses Bing (primary) or Baidu (fallback).',
    'Types: "text" (general web), "news" (recent news), "baidu" (Chinese-focused).',
    'Good for: current events, stock prices, technical docs, general knowledge.',
  ].join(' '),
  schema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query' },
      type: { type: 'string', enum: ['text', 'news', 'baidu'], description: 'Search type (default: text)' },
      maxResults: { type: 'number', description: 'Max results (default: 8, max: 20)' },
      region: { type: 'string', description: 'Region: "zh-cn" or "en-us" (default: zh-cn)' },
    },
    required: ['query'],
  },
  handler: async (params: Record<string, unknown>) => {
    const query = params['query'] as string;
    const type = (params['type'] as string) ?? 'text';
    const maxResults = Math.min(Number(params['maxResults'] ?? 8), 20);
    const region = (params['region'] as string) ?? 'zh-cn';

    try {
      let results: Array<{ title: string; url: string; snippet: string }>;

      if (type === 'news') {
        results = await searchNews(query, maxResults);
        if (!results.length) results = await searchBing(query + ' 最新新闻', maxResults, region);
        if (!results.length) results = await searchBaidu(query + ' 最新', maxResults);
      } else if (type === 'baidu') {
        results = await searchBaidu(query, maxResults);
      } else {
        // Default: try Bing first, then Baidu
        results = await searchBing(query, maxResults, region);
        if (!results.length || !resultsLookValid(results)) {
          results = await searchBaidu(query, maxResults);
        }
      }

      // Final quality gate: if results are clearly garbage, return empty
      if (!resultsLookValid(results)) {
        return { type: 'text', text: '搜索引擎返回结果异常（可能被限流或页面结构变化），请稍后重试或尝试 type: "baidu"。' };
      }

      return { type: 'text', text: formatResults(results) };
    } catch (err: any) {
      return { type: 'error', error: `搜索失败: ${err.message}` };
    }
  },
  toolset: ['default'],
  requiresApproval: false,
  executionMode: 'parallel',
});
