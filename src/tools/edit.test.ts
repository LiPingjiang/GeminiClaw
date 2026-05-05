import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises'
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

describe('edit tool', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'edit-test-'))
  })

  afterEach(async () => {
    await rm(tmpDir, { recursive: true })
  })

  it('applies a single edit successfully', async () => {
    const filePath = join(tmpDir, 'file.txt')
    await writeFile(filePath, 'hello world\n', 'utf8')

    const tool = registry.get('edit')!
    const result = await tool.handler({
      path: filePath,
      edits: [{ oldText: 'hello', newText: 'goodbye' }],
    }, makeCtx())

    expect(result.type).toBe('text')
    const content = await readFile(filePath, 'utf8')
    expect(content).toBe('goodbye world\n')
  })

  it('applies multiple edits in sequence', async () => {
    const filePath = join(tmpDir, 'multi.txt')
    await writeFile(filePath, 'foo bar baz\n', 'utf8')

    const tool = registry.get('edit')!
    const result = await tool.handler({
      path: filePath,
      edits: [
        { oldText: 'foo', newText: 'FOO' },
        { oldText: 'baz', newText: 'BAZ' },
      ],
    }, makeCtx())

    expect(result.type).toBe('text')
    const content = await readFile(filePath, 'utf8')
    expect(content).toBe('FOO bar BAZ\n')
  })

  it('returns error when oldText is not found', async () => {
    const filePath = join(tmpDir, 'notfound.txt')
    await writeFile(filePath, 'hello world\n', 'utf8')

    const tool = registry.get('edit')!
    const result = await tool.handler({
      path: filePath,
      edits: [{ oldText: 'nonexistent text', newText: 'replacement' }],
    }, makeCtx())

    expect(result.type).toBe('error')
    if (result.type === 'error') {
      expect(result.error).toContain('not found')
    }
  })

  it('returns error when oldText appears multiple times', async () => {
    const filePath = join(tmpDir, 'duplicate.txt')
    await writeFile(filePath, 'foo foo foo\n', 'utf8')

    const tool = registry.get('edit')!
    const result = await tool.handler({
      path: filePath,
      edits: [{ oldText: 'foo', newText: 'bar' }],
    }, makeCtx())

    expect(result.type).toBe('error')
    if (result.type === 'error') {
      expect(result.error).toContain('multiple times')
    }
  })

  it('writes the corrected content back to the file', async () => {
    const filePath = join(tmpDir, 'writeback.txt')
    const original = 'const x = 1\nconst y = 2\nconst z = 3\n'
    await writeFile(filePath, original, 'utf8')

    const tool = registry.get('edit')!
    await tool.handler({
      path: filePath,
      edits: [{ oldText: 'const y = 2', newText: 'const y = 42' }],
    }, makeCtx())

    const content = await readFile(filePath, 'utf8')
    expect(content).toBe('const x = 1\nconst y = 42\nconst z = 3\n')
  })
})
