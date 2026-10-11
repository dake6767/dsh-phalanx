import { mkdtemp, open, readFile, writeFile, chmod, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { FileExecutionProjection } from '../src/adapters/execution-projection.js'

it('keeps an already-open forwarding program intact while atomically publishing changed commands', async () => {
  const root = await mkdtemp(join(tmpdir(), 'execution-publication-'))
  let commands = [{ owner: 'skill:news', skill: 'news', command: 'news-cli' }]
  const projection = new FileExecutionProjection(root, undefined, () => commands)
  try {
    await projection.prepare('member')
    const dispatch = join(root, 'member/commands/dispatch.mjs')
    const previous = '// Earlier installed release\n' + await readFile(dispatch, 'utf8')
    await chmod(dispatch, 0o700); await writeFile(dispatch, previous)
    const reading = await open(dispatch)
    try {
      commands = [...commands, { owner: 'skill:news', skill: 'news', command: 'second-cli' }]
      await projection.prepare('member')
      expect(await reading.readFile('utf8')).toBe(previous)
      expect(await readFile(dispatch, 'utf8')).not.toBe(previous)
      expect(await readFile(join(root, 'member/commands/live/second-cli'), 'utf8')).toContain('skill:news')
    } finally { await reading.close() }
  } finally { await rm(root, { recursive: true, force: true }) }
})
