import { writeFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { registry } from './registry.js'
import type { ToolContext, ToolResult } from './types.js'

async function writeHandler(
  params: Record<string, unknown>,
  _ctx: ToolContext
): Promise<ToolResult> {
  const filePath = params['path'] as string
  const content = params['content'] as string

  try {
    await mkdir(dirname(filePath), { recursive: true })
  } catch (err) {
    return { type: 'error', error: `Failed to create directories: ${(err as Error).message}` }
  }

  try {
    await writeFile(filePath, content, 'utf8')
    return { type: 'text', text: `Successfully wrote ${content.length} bytes to ${filePath}` }
  } catch (err) {
    return { type: 'error', error: `Failed to write file: ${(err as Error).message}` }
  }
}

registry.register({
  name: 'write',
  description: 'Write content to a file, creating parent directories as needed',
  schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the file to write' },
      content: { type: 'string', description: 'Content to write to the file' },
    },
    required: ['path', 'content'],
  },
  handler: writeHandler,
  toolset: ['default'],
  requiresApproval: true,
  executionMode: 'sequential',
})
