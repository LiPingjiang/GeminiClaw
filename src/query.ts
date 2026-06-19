// src/query.ts — Mock implementation for CC visual demo
// Streams a fake response so REPL.tsx renders with full CC visual effects.
// No backend needed — demonstrates the CC TUI appearance.

import { randomUUID } from 'crypto'

// ── Helpers ───────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}

/** Fake responses keyed by keywords in the user message */
const MOCK_RESPONSES: Array<{ match: RegExp; response: string }> = [
  {
    match: /hello|hi|你好|嗨/i,
    response: `你好！我是 GeminiClaw，基于 Claude Code 的渲染引擎运行的 AI 助手。

目前正在运行 **Claude Code TUI 视觉演示模式**，使用 mock 回复展示视觉效果。

有什么我可以帮你的吗？`,
  },
  {
    match: /tool|工具|sandbox|exec/i,
    response: `当前处于演示模式，工具调用功能暂时 mock。

实际运行时将支持：
- \`sandbox_exec\` — 在 E2B 沙箱中执行代码
- \`read\` / \`write\` — 文件读写
- \`exec\` — 本机命令执行
- \`dragon_api\` — 龙股数据接口`,
  },
  {
    match: /version|版本/i,
    response: `**GeminiClaw** — Claude Code 视觉移植版

- 渲染引擎：Claude Code Ink fork（完整移植）
- 主题系统：ThemedBox / ThemedText / ThemeProvider
- 动画：SpinnerAnimationRow + ClockContext
- 布局：FullscreenLayout + VirtualMessageList
- 后端：GeminiClaw Agent Server (port 18790)`,
  },
]

function getMockResponse(userText: string): string {
  for (const { match, response } of MOCK_RESPONSES) {
    if (match.test(userText)) return response
  }
  // Default
  return `我收到了你的消息："${userText.slice(0, 100)}${userText.length > 100 ? '…' : ''}"

这是 **GeminiClaw TUI 演示模式** 的 mock 回复。

正在展示 Claude Code 的完整视觉效果：
- ✻ 旋转 spinner（Puttering、Thinking、Working…）
- 流式文字渲染
- Markdown 高亮（**粗体**、\`代码\`、列表）
- FullscreenLayout + ScrollBox

切换到真实后端：去掉 \`GC_USE_REPL=1\` 或使用 \`pnpm tsx src/cli/index.ts tui\``
}

// ── CC event helpers ──────────────────────────────────────────────────────────

function makeMessageStart(msgId: string) {
  return {
    type: 'stream_event' as const,
    event: {
      type: 'message_start',
      message: {
        id: msgId,
        type: 'message',
        role: 'assistant',
        content: [],
        model: 'geminiclaw-demo',
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 0 },
      },
    },
  }
}

function makeContentBlockStart(blockIdx = 0) {
  return {
    type: 'stream_event' as const,
    event: {
      type: 'content_block_start',
      index: blockIdx,
      content_block: { type: 'text', text: '' },
    },
  }
}

function makeDelta(text: string, blockIdx = 0) {
  return {
    type: 'stream_event' as const,
    event: {
      type: 'content_block_delta',
      index: blockIdx,
      delta: { type: 'text_delta', text },
    },
  }
}

function makeContentBlockStop(blockIdx = 0) {
  return {
    type: 'stream_event' as const,
    event: { type: 'content_block_stop', index: blockIdx },
  }
}

function makeMessageStop(msgId: string, fullText: string) {
  return {
    type: 'stream_event' as const,
    event: {
      type: 'message_stop',
      message: {
        id: msgId,
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: fullText }],
        model: 'geminiclaw-demo',
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: Math.ceil(fullText.length / 4) },
      },
    },
  }
}

function makeFinalAssistant(msgId: string, fullText: string) {
  return {
    type: 'assistant' as const,
    message: {
      id: msgId,
      type: 'message',
      role: 'assistant' as const,
      content: [{ type: 'text', text: fullText }],
      model: 'geminiclaw-demo',
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: Math.ceil(fullText.length / 4) },
    },
  }
}

// ── Main query() generator ────────────────────────────────────────────────────

/** CC-compatible query() that streams mock responses. */
export async function* query(params: {
  messages: any[]
  systemPrompt?: any
  userContext?: any
  systemContext?: any
  canUseTool?: any
  toolUseContext?: any
  querySource?: any
}): AsyncGenerator<any> {
  // 1. Request start — sets spinner to 'requesting'
  yield { type: 'stream_request_start' }

  // Small delay to simulate network
  await sleep(200 + Math.random() * 300)

  // 2. Find last user message
  const messages = params.messages ?? []
  let userText = ''
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m?.role === 'user' || m?.type === 'user') {
      const c = m.content ?? m.message?.content
      if (typeof c === 'string') { userText = c; break }
      if (Array.isArray(c)) {
        const textPart = c.find((p: any) => p.type === 'text')
        if (textPart?.text) { userText = textPart.text; break }
      }
    }
  }

  const msgId = `msg_${randomUUID().replace(/-/g, '').slice(0, 24)}`
  const responseText = getMockResponse(userText)

  // 3. message_start — triggers TTFT metric + transitions spinner
  yield makeMessageStart(msgId)
  await sleep(50)

  // 4. content_block_start — spinner → 'responding' mode
  yield makeContentBlockStart(0)
  await sleep(30)

  // 5. Stream text character by character (variable speed for realism)
  let streamed = ''
  // Stream in chunks of 1-5 chars with variable delay
  let i = 0
  while (i < responseText.length) {
    const chunkSize = 1 + Math.floor(Math.random() * 4)
    const chunk = responseText.slice(i, i + chunkSize)
    i += chunkSize

    yield makeDelta(chunk, 0)
    streamed += chunk

    // Variable delay: faster for regular text, pause on punctuation
    const lastChar = chunk.at(-1) ?? ''
    if ('.!?。！？'.includes(lastChar)) {
      await sleep(60 + Math.random() * 60)
    } else if (',，、'.includes(lastChar)) {
      await sleep(20 + Math.random() * 30)
    } else if (lastChar === '\n') {
      await sleep(30 + Math.random() * 40)
    } else {
      await sleep(8 + Math.random() * 12)
    }
  }

  // 6. Stop events
  yield makeContentBlockStop(0)
  await sleep(30)
  yield makeMessageStop(msgId, responseText)
  await sleep(20)

  // 7. Final assistant message — saved to REPL messages array
  yield makeFinalAssistant(msgId, responseText)
}

// ── Re-exports for CC compatibility ──────────────────────────────────────────

export type Query = any
export type QueryParams = any
