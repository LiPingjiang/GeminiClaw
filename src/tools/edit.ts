import { readFile, writeFile } from 'node:fs/promises'
import { registry } from './registry.js'
import type { ToolContext, ToolResult } from './types.js'

interface EditItem {
  oldText: string
  newText: string
}

async function editHandler(
  params: Record<string, unknown>,
  _ctx: ToolContext
): Promise<ToolResult> {
  const filePath = params['path'] as string
  const edits = params['edits'] as EditItem[]

  let content: string
  try {
    content = await readFile(filePath, 'utf8')
  } catch (err) {
    return { type: 'error', error: `Failed to read file: ${(err as Error).message}` }
  }

  let current = content

  for (const edit of edits) {
    const { oldText, newText } = edit

    const firstIdx = current.indexOf(oldText)
    if (firstIdx === -1) {
      return {
        type: 'error',
        error: `Text not found in file: ${JSON.stringify(oldText.slice(0, 80))}`,
      }
    }

    // Check for duplicate occurrences
    const secondIdx = current.indexOf(oldText, firstIdx + 1)
    if (secondIdx !== -1) {
      return {
        type: 'error',
        error: `Text appears multiple times in file (must be unique): ${JSON.stringify(oldText.slice(0, 80))}`,
      }
    }

    current = current.slice(0, firstIdx) + newText + current.slice(firstIdx + oldText.length)
  }

  try {
    await writeFile(filePath, current, 'utf8')
    return { type: 'text', text: `Successfully applied ${edits.length} edit(s) to ${filePath}` }
  } catch (err) {
    return { type: 'error', error: `Failed to write file: ${(err as Error).message}` }
  }
}

registry.register({
  name: 'edit',
  description: 'Apply precise text replacements to a file',
  schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the file to edit' },
      edits: {
        type: 'array',
        description: 'List of text replacements to apply',
        items: {
          type: 'object',
          properties: {
            oldText: { type: 'string', description: 'Exact text to replace (must be unique in file)' },
            newText: { type: 'string', description: 'Replacement text' },
          },
          required: ['oldText', 'newText'],
        },
      },
    },
    required: ['path', 'edits'],
  },
  handler: editHandler,
  toolset: ['default'],
  requiresApproval: true,
  executionMode: 'sequential',
})
