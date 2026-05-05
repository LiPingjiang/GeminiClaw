import { describe, it, expect, beforeEach } from 'vitest'
import { ToolRegistry } from './registry.js'
import type { ToolDefinition } from './types.js'

function makeTool(name: string, toolset?: string[]): ToolDefinition {
  return {
    name,
    description: `Tool ${name}`,
    schema: { type: 'object', properties: { input: { type: 'string' } }, required: ['input'] },
    handler: async () => ({ type: 'text', text: 'ok' }),
    toolset,
  }
}

describe('ToolRegistry', () => {
  let reg: ToolRegistry

  beforeEach(() => {
    reg = new ToolRegistry()
  })

  it('register + get works', () => {
    const tool = makeTool('my_tool')
    reg.register(tool)
    expect(reg.get('my_tool')).toBe(tool)
  })

  it('list() returns all registered tools', () => {
    reg.register(makeTool('a'))
    reg.register(makeTool('b'))
    reg.register(makeTool('c'))
    const all = reg.list()
    expect(all).toHaveLength(3)
    expect(all.map(t => t.name)).toEqual(expect.arrayContaining(['a', 'b', 'c']))
  })

  it('list(toolset) filters by toolset', () => {
    reg.register(makeTool('tool1', ['default', 'special']))
    reg.register(makeTool('tool2', ['default']))
    reg.register(makeTool('tool3', ['special']))
    reg.register(makeTool('tool4'))

    const defaults = reg.list('default')
    expect(defaults).toHaveLength(2)
    expect(defaults.map(t => t.name)).toEqual(expect.arrayContaining(['tool1', 'tool2']))

    const special = reg.list('special')
    expect(special).toHaveLength(2)
  })

  it('toAnthropicTools() returns correct format', () => {
    reg.register(makeTool('alpha', ['default']))
    const tools = reg.toAnthropicTools()
    expect(tools).toHaveLength(1)
    expect(tools[0]).toEqual({
      name: 'alpha',
      description: 'Tool alpha',
      input_schema: {
        type: 'object',
        properties: { input: { type: 'string' } },
        required: ['input'],
      },
    })
  })

  it('get() returns null for unknown tool', () => {
    expect(reg.get('nonexistent')).toBeNull()
  })
})
