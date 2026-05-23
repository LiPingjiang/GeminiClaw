// src/tools/evolution_command.ts
// 进化命令工具 — 将 /进化 /技能 等斜杠命令路由到对应的命令处理器

import { registry } from './registry.js'
import type { ToolContext, ToolResult } from './types.js'

async function evolutionCommandHandler(
  params: Record<string, unknown>,
  _ctx: ToolContext
): Promise<ToolResult> {
  const command = params['command'] as string | undefined
  const args = (params['args'] as string[] | undefined) ?? []

  if (!command) {
    return { type: 'error', error: '未指定命令' }
  }

  if (command === 'help') {
    return {
      type: 'text',
      text: [
        '**GeminiClaw 可用命令：**',
        '',
        '`/进化` — 查看待确认的进化候选项',
        '`/进化 预览 N` — 预览第 N 个候选项',
        '`/进化 确认 N` — 应用第 N 个候选项',
        '`/进化 拒绝 N` — 拒绝第 N 个候选项',
        '`/技能 列表` — 查看已加载的技能',
        '`/状态` — 查看系统状态',
      ].join('\n'),
    }
  }

  // 从全局获取 evolution 引擎实例（由 server/index.ts 在启动时注入）
  const globalAny = globalThis as Record<string, unknown>
  const engine = globalAny['__evolutionEngine']

  if (!engine) {
    return { type: 'text', text: '⚠️ 进化引擎未启动，无法执行进化命令。' }
  }

  try {
    const { EvolutionCommandHandler } = await import('../commands/evolution.js')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const handler = new EvolutionCommandHandler(engine as any, engine as any)
    const result = await handler.handle(command, args)
    return { type: 'text', text: result }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { type: 'error', error: `命令执行失败: ${message}` }
  }
}

registry.register({
  name: 'evolution_command',
  description: '执行斜杠命令，如 /进化、/技能、/状态、/help',
  schema: {
    type: 'object',
    properties: {
      command: { type: 'string', description: '命令名称（不含斜杠）' },
      args: { type: 'array', items: { type: 'string' }, description: '命令参数列表' },
    },
    required: ['command'],
  },
  handler: evolutionCommandHandler,
})
