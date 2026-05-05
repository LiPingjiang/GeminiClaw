import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolContext } from './types.js'

import { registry } from './index.js'

function makeCtx(workdir = '/tmp'): ToolContext {
  return {
    sessionId: 'test',
    workdir,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  }
}

describe('write tool', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'write-test-'))
  })

  afterEach(async () => {
    await rm(tmpDir, { recursive: true })
  })

  it('writes a file successfully', async () => {
    const filePath = join(tmpDir, 'output.txt')
    const tool = registry.get('write')!
    const result = await tool.handler({ path: filePath, content: 'hello world' }, makeCtx())
    expect(result.type).toBe('text')

    const written = await readFile(filePath, 'utf8')
    expect(written).toBe('hello world')
  })

  it('automatically creates parent directories', async () => {
    const filePath = join(tmpDir, 'a', 'b', 'c', 'deep.txt')
    const tool = registry.get('write')!
    const result = await tool.handler({ path: filePath, content: 'deep content' }, makeCtx())
    expect(result.type).toBe('text')

    const written = await readFile(filePath, 'utf8')
    expect(written).toBe('deep content')
  })

  it('overwrites an existing file', async () => {
    const filePath = join(tmpDir, 'existing.txt')
    const tool = registry.get('write')!

    await tool.handler({ path: filePath, content: 'original' }, makeCtx())
    await tool.handler({ path: filePath, content: 'overwritten' }, makeCtx())

    const written = await readFile(filePath, 'utf8')
    expect(written).toBe('overwritten')
  })

  it('returns error for invalid path', async () => {
    const tool = registry.get('write')!
    // Writing to a path where a parent is actually a file
    const existing = join(tmpDir, 'afile.txt')
    const { writeFile } = await import('node:fs/promises')
    await writeFile(existing, 'content', 'utf8')

    const result = await tool.handler({ path: join(existing, 'sub', 'file.txt'), content: 'x' }, makeCtx())
    expect(result.type).toBe('error')
  })
})
