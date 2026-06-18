// src/cli/tui/commands/registry.ts
import type React from 'react'
import type { TuiAction } from '../state.js'

export interface CommandContext {
  dispatch: React.Dispatch<TuiAction>
  sendMessage: (msg: string) => void
  exit: () => void
  baseUrl: string
  authToken?: string
}

export interface TuiCommand {
  name: string
  prefix: string
  description: string
  argHint?: string
  handler: (args: string, ctx: CommandContext) => void | Promise<void>
}

export const COMMANDS: TuiCommand[] = [
  {
    name: 'btw',
    prefix: '/btw',
    description: '旁路问题，不入主对话',
    argHint: '<question>',
    handler: (_args, _ctx) => { /* wired in Task 4 */ },
  },
  {
    name: 'clear',
    prefix: '/clear',
    description: '清空消息流',
    handler: (_args, ctx) => ctx.dispatch({ type: 'CLEAR' }),
  },
  {
    name: 'session',
    prefix: '/session',
    description: '切换或列出 session',
    argHint: '[id]',
    handler: (_args, _ctx) => { /* wired in Task 5 */ },
  },
  {
    name: 'new',
    prefix: '/new',
    description: '新建 session',
    handler: (_args, ctx) => ctx.dispatch({ type: 'SET_NEW_SESSION' }),
  },
  {
    name: 'model',
    prefix: '/model',
    description: '显示或切换模型',
    argHint: '[name]',
    handler: (args, ctx) => {
      if (args) {
        ctx.dispatch({ type: 'SSE_EVENT', event: { kind: 'system', message: `Model: ${args} (restart server to apply)` } })
      } else {
        ctx.dispatch({ type: 'SSE_EVENT', event: { kind: 'system', message: 'Usage: /model <name>' } })
      }
    },
  },
  {
    name: 'cost',
    prefix: '/cost',
    description: '显示本次 token 消耗',
    handler: (_args, ctx) => ctx.dispatch({ type: 'SHOW_COST' }),
  },
  {
    name: 'copy',
    prefix: '/copy',
    description: '复制最后一条回复到剪贴板',
    handler: (_args, ctx) => ctx.dispatch({ type: 'COPY_LAST' }),
  },
  {
    name: 'diff',
    prefix: '/diff',
    description: '显示当前目录 git diff',
    handler: (_args, ctx) => ctx.sendMessage('/diff'),
  },
  {
    name: 'bg',
    prefix: '/bg',
    description: '后台发送，不锁定输入',
    argHint: '<message>',
    handler: (args, ctx) => {
      if (!args.trim()) return
      ctx.dispatch({ type: 'BG_START' })
      // streamChat call wired in Task 4 handlers.ts
    },
  },
  {
    name: 'help',
    prefix: '/help',
    description: '显示命令列表',
    handler: (_args, ctx) => {
      const list = COMMANDS.map(c => `${c.prefix.padEnd(12)} ${c.description}`).join('\n')
      ctx.dispatch({ type: 'SSE_EVENT', event: { kind: 'system', message: `Commands:\n${list}` } })
    },
  },
  {
    name: 'quit',
    prefix: '/quit',
    description: '退出',
    handler: (_args, ctx) => ctx.exit(),
  },
]

/**
 * Filter commands by query (prefix match + substring fallback).
 * Returns at most 6 results.
 */
export function filterCommands(query: string): TuiCommand[] {
  if (!query) return COMMANDS.slice(0, 6)
  const q = query.toLowerCase()
  const prefixMatches = COMMANDS.filter(c => c.name.startsWith(q))
  const substringMatches = COMMANDS.filter(c => !c.name.startsWith(q) && c.name.includes(q))
  return [...prefixMatches, ...substringMatches].slice(0, 6)
}
