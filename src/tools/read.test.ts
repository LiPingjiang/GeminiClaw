import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
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

describe('read tool', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'read-test-'))
  })

  afterEach(async () => {
    await rm(tmpDir, { recursive: true })
  })

  it('reads a file and returns its content', async () => {
    const filePath = join(tmpDir, 'hello.txt')
    await writeFile(filePath, 'line1\nline2\nline3', 'utf8')

    const tool = registry.get('read')!
    const result = await tool.handler({ path: filePath }, makeCtx())
    expect(result.type).toBe('text')
    if (result.type === 'text') {
      expect(result.text).toContain('line1')
      expect(result.text).toContain('line3')
    }
  })

  it('offset and limit parameters work correctly', async () => {
    const filePath = join(tmpDir, 'lines.txt')
    const lines = Array.from({ length: 10 }, (_, i) => `line${i + 1}`).join('\n')
    await writeFile(filePath, lines, 'utf8')

    const tool = registry.get('read')!
    const result = await tool.handler({ path: filePath, offset: 3, limit: 3 }, makeCtx())
    expect(result.type).toBe('text')
    if (result.type === 'text') {
      expect(result.text).toContain('line3')
      expect(result.text).toContain('line5')
      expect(result.text).not.toContain('line1')
      expect(result.text).not.toContain('line6')
    }
  })

  it('returns error when file does not exist', async () => {
    const tool = registry.get('read')!
    const result = await tool.handler({ path: join(tmpDir, 'nonexistent.txt') }, makeCtx())
    expect(result.type).toBe('error')
    if (result.type === 'error') {
      expect(result.error).toContain('not found')
    }
  })

  it('truncates files exceeding 2000 lines', async () => {
    const filePath = join(tmpDir, 'big.txt')
    const content = Array.from({ length: 2500 }, (_, i) => `line${i + 1}`).join('\n')
    await writeFile(filePath, content, 'utf8')

    const tool = registry.get('read')!
    const result = await tool.handler({ path: filePath }, makeCtx())
    expect(result.type).toBe('text')
    if (result.type === 'text') {
      expect(result.text).toContain('[truncated')
      // Should not contain line 2001
      expect(result.text).not.toContain('line2001')
    }
  })

  it('returns error when path is a directory', async () => {
    const tool = registry.get('read')!
    const result = await tool.handler({ path: tmpDir }, makeCtx())
    expect(result.type).toBe('error')
    if (result.type === 'error') {
      expect(result.error).toContain('directory')
    }
  })
})
