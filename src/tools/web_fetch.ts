import { get as httpsGet } from 'node:https'
import { get as httpGet } from 'node:http'
import type { IncomingMessage } from 'node:http'
import { registry } from './registry.js'
import type { ToolContext, ToolResult } from './types.js'

const DEFAULT_MAX_CHARS = 20000

function htmlToMarkdown(html: string): string {
  let md = html

  // Remove <script> blocks
  md = md.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
  // Remove <style> blocks
  md = md.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
  // Remove <head> block
  md = md.replace(/<head\b[^>]*>[\s\S]*?<\/head>/gi, '')

  // Headings
  md = md.replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, '\n# $1\n')
  md = md.replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, '\n## $1\n')
  md = md.replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, '\n### $1\n')
  md = md.replace(/<h4[^>]*>([\s\S]*?)<\/h4>/gi, '\n#### $1\n')
  md = md.replace(/<h5[^>]*>([\s\S]*?)<\/h5>/gi, '\n##### $1\n')
  md = md.replace(/<h6[^>]*>([\s\S]*?)<\/h6>/gi, '\n###### $1\n')

  // Links
  md = md.replace(/<a\s+[^>]*href=["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi, '[$2]($1)')

  // Bold / italic
  md = md.replace(/<(?:strong|b)[^>]*>([\s\S]*?)<\/(?:strong|b)>/gi, '**$1**')
  md = md.replace(/<(?:em|i)[^>]*>([\s\S]*?)<\/(?:em|i)>/gi, '_$1_')

  // Code
  md = md.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, '`$1`')
  md = md.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, '\n```\n$1\n```\n')

  // List items
  md = md.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, '\n- $1')

  // Paragraphs and divs
  md = md.replace(/<\/p>/gi, '\n\n')
  md = md.replace(/<p[^>]*>/gi, '')
  md = md.replace(/<\/div>/gi, '\n')
  md = md.replace(/<div[^>]*>/gi, '\n')

  // Line breaks
  md = md.replace(/<br\s*\/?>/gi, '\n')

  // Remove all remaining HTML tags
  md = md.replace(/<[^>]+>/g, '')

  // Decode common HTML entities
  md = md.replace(/&amp;/g, '&')
  md = md.replace(/&lt;/g, '<')
  md = md.replace(/&gt;/g, '>')
  md = md.replace(/&quot;/g, '"')
  md = md.replace(/&#39;/g, "'")
  md = md.replace(/&nbsp;/g, ' ')

  // Collapse excessive blank lines
  md = md.replace(/\n{3,}/g, '\n\n')

  return md.trim()
}

function fetchUrl(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url)
    const getter = parsed.protocol === 'https:' ? httpsGet : httpGet

    const req = getter(url, { headers: { 'User-Agent': 'GeminiClaw/1.0' } }, (res: IncomingMessage) => {
      // Handle redirects
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        fetchUrl(res.headers.location).then(resolve).catch(reject)
        return
      }

      if (res.statusCode && res.statusCode >= 400) {
        reject(new Error(`HTTP ${res.statusCode}`))
        return
      }

      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      res.on('error', reject)
    })

    req.on('error', reject)
    req.setTimeout(15000, () => {
      req.destroy()
      reject(new Error('Request timed out'))
    })
  })
}

async function webFetchHandler(
  params: Record<string, unknown>,
  _ctx: ToolContext
): Promise<ToolResult> {
  const url = params['url'] as string
  const maxChars = (params['maxChars'] as number | undefined) ?? DEFAULT_MAX_CHARS

  let raw: string
  try {
    raw = await fetchUrl(url)
  } catch (err) {
    return { type: 'error', error: `Failed to fetch URL: ${(err as Error).message}` }
  }

  const markdown = htmlToMarkdown(raw)
  const truncated = markdown.length > maxChars ? markdown.slice(0, maxChars) + '\n...[truncated]' : markdown

  return { type: 'text', text: truncated }
}

registry.register({
  name: 'web_fetch',
  description: 'Fetch a URL and return its content as markdown',
  schema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'URL to fetch' },
      maxChars: { type: 'number', description: `Maximum characters to return (default ${DEFAULT_MAX_CHARS})` },
    },
    required: ['url'],
  },
  handler: webFetchHandler,
  toolset: ['default'],
  requiresApproval: false,
  executionMode: 'parallel',
})
