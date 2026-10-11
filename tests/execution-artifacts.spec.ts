import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { FileExecutionArtifacts } from '../src/adapters/execution-artifacts.js'

it('freezes complete prepared trees by content and preserves older published dependencies', async () => {
  const root = await mkdtemp(join(tmpdir(), 'execution-artifacts-')), artifacts = new FileExecutionArtifacts(root)
  try {
    const first = await artifacts.stage(); await mkdir(join(first.directory, 'deps')); await writeFile(join(first.directory, 'deps/value'), 'first')
    const one = await artifacts.publish(first, 'v1', 'identity', 'log')
    expect((await stat(join(artifacts.directory(one.id), 'deps/value'))).mode & 0o222).toBe(0)
    const second = await artifacts.stage(); await mkdir(join(second.directory, 'deps')); await writeFile(join(second.directory, 'deps/value'), 'second')
    const two = await artifacts.publish(second, 'v1', 'identity', 'log')
    expect(two.hash).not.toBe(one.hash)
    expect(await readFile(join(artifacts.directory(one.id), 'deps/value'), 'utf8')).toBe('first')
    expect(await readFile(join(artifacts.directory(two.id), 'deps/value'), 'utf8')).toBe('second')
    const interrupted = await artifacts.stage(); await writeFile(join(interrupted.directory, 'partial'), 'unfinished')
    await artifacts.collect([two.id]); await expect(stat(interrupted.directory)).rejects.toMatchObject({ code: 'ENOENT' }); await expect(stat(artifacts.directory(one.id))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(join(artifacts.directory(two.id), 'deps/value'), 'utf8')).toBe('second')
  } finally { await artifacts.collect([]); await rm(root, { recursive: true, force: true }) }
})
