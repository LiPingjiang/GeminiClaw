import { describe, it, expect } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolContext } from './types.js'

// Import registry to trigger registration
import { registry } from './index.js'

function makeCtx(workdir = '/tmp'): ToolContext {
  return {
    sessionId: 'test',
    workdir,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  }
}

describe('exec tool', () => {
  it('executes a simple command and returns stdout', async () => {
    const tool = registry.get('exec')!
    const result = await tool.handler({ command: 'echo hello' }, makeCtx())
    expect(result.type).toBe('text')
    if (result.type === 'text') {
      expect(result.text.trim()).toBe('hello')
    }
  })

  it('returns error on non-zero exit code', async () => {
    const tool = registry.get('exec')!
    const result = await tool.handler({ command: 'exit 1' }, makeCtx())
    expect(result.type).toBe('error')
  })

  it('truncates output exceeding 8000 chars', async () => {
    const tool = registry.get('exec')!
    // Generate ~9000 '=' chars via awk
    const result = await tool.handler(
      { command: "awk 'BEGIN{s=\"\"; for(i=0;i<9000;i++) s=s\"=\"; print s}'" },
      makeCtx()
    )
    expect(result.type).toBe('text')
    if (result.type === 'text') {
      expect(result.text).toContain('[truncated]')
      expect(result.text.length).toBeLessThan(9000)
    }
  })

  it('returns error on timeout', async () => {
    const tool = registry.get('exec')!
    const result = await tool.handler({ command: 'sleep 10', timeout: 1 }, makeCtx())
    expect(result.type).toBe('error')
    if (result.type === 'error') {
      expect(result.error).toContain('timed out')
    }
  }, 5000)

  it('workdir parameter is respected', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'exec-test-'))
    try {
      const tool = registry.get('exec')!
      const result = await tool.handler({ command: 'pwd', workdir: tmpDir }, makeCtx())
      expect(result.type).toBe('text')
      if (result.type === 'text') {
        // On macOS, /var/folders symlinks to /private/var/folders
        expect(result.text.trim()).toContain(tmpDir.replace('/var/', '/private/var/') || tmpDir)
      }
    } finally {
      await rm(tmpDir, { recursive: true })
    }
  })
})
