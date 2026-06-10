// @ts-nocheck
// src/tools/view_image.ts
// Tool: view_image — Fetch an image URL and return as multimodal envelope
// for the vision model to analyze.
import { registry } from './registry.js';

registry.register({
  name: 'view_image',
  description: [
    'Fetch and view an image from a URL for visual analysis.',
    'Accepts http/https URLs or data: URIs.',
    'Returns the image as a multimodal block for the vision model to see and describe.',
    'Use this tool when you need to analyze, describe, or understand the content of an image.',
  ].join('\n'),
  schema: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: 'Image URL (https:// or data:image/...) to fetch and analyze',
      },
      question: {
        type: 'string',
        description: 'Optional: specific question to focus the analysis on',
      },
    },
    required: ['url'],
  },
  handler: async (params) => {
    const url = String(params['url'] ?? '').trim();
    const question = String(params['question'] ?? '').trim();

    if (!url) {
      return { type: 'error', error: 'url parameter is required' };
    }

    // ── data: URI — already base64 encoded, pass through directly ────────────
    if (url.startsWith('data:image/')) {
      const contextText = question
        ? `[Image loaded from data URI. Question: ${question}]`
        : '[Image loaded from data URI for analysis]';
      return {
        type: 'multimodal',
        content: [
          { type: 'text', text: contextText },
          { type: 'image_url', image_url: { url, detail: 'auto' } },
        ],
        textSummary: contextText,
      };
    }

    // ── HTTP(S) URL — fetch the image and convert to base64 ─────────────────
    if (url.startsWith('http://') || url.startsWith('https://')) {
      try {
        const response = await fetch(url, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (compatible; GeminiClaw/1.0)',
            'Accept': 'image/*',
          },
          signal: AbortSignal.timeout(30000),
        });

        if (!response.ok) {
          return { type: 'error', error: `Failed to fetch image: HTTP ${response.status} ${response.statusText}` };
        }

        const contentType = response.headers.get('content-type') ?? 'image/jpeg';
        if (!contentType.startsWith('image/')) {
          return { type: 'error', error: `URL did not return an image (content-type: ${contentType})` };
        }

        const buffer = Buffer.from(await response.arrayBuffer());
        const b64 = buffer.toString('base64');
        const dataUrl = `data:${contentType};base64,${b64}`;

        const sizeKB = Math.round(buffer.length / 1024);
        const contextText = question
          ? `[Image fetched: ${sizeKB}KB ${contentType}. Question: ${question}]`
          : `[Image fetched: ${sizeKB}KB ${contentType}]`;

        return {
          type: 'multimodal',
          content: [
            { type: 'text', text: contextText },
            { type: 'image_url', image_url: { url: dataUrl, detail: 'auto' } },
          ],
          textSummary: contextText,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { type: 'error', error: `Failed to fetch image: ${msg}` };
      }
    }

    return { type: 'error', error: `Unsupported URL scheme. Expected http://, https://, or data:image/...` };
  },
  toolset: ['default'],
  requiresApproval: false,
  executionMode: 'parallel',
});
