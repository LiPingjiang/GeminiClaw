// src/tools/show_diff.ts
import { registry } from './registry.js'

registry.register({
  name: 'show_diff',
  description: [
    'Display a before/after diff of text content in the TUI.',
    'Use when showing document changes, config modifications, or code edits.',
    'The diff renders inline in the conversation with red/green line highlighting.',
  ].join(' '),
  schema: {
    type: 'object',
    properties: {
      filename: {
        type: 'string',
        description: 'Display name for the file or document being diffed',
      },
      before: {
        type: 'string',
        description: 'Original content (before changes)',
      },
      after: {
        type: 'string',
        description: 'New content (after changes)',
      },
    },
    required: ['filename', 'before', 'after'],
  },
  handler: async (params) => ({
    type: 'diff',
    filename: params['filename'] as string,
    before: params['before'] as string,
    after: params['after'] as string,
  }) as any,
  toolset: ['default'],
  requiresApproval: false,
  executionMode: 'sequential',
})
