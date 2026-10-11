import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { ContainerExecutionPreparer } from '../src/adapters/execution-preparer.js'
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

it('retains stages and published artifacts after container cleanup failure until recovery succeeds', async () => {
  const root = await mkdtemp(join(tmpdir(), 'execution-cleanup-')), artifacts = new FileExecutionArtifacts(join(root, 'artifacts'))
  let safe = false
  const process = { get canDiscardArtifacts() { return safe }, recover: async () => { safe = true }, imageIdentity: async () => 'fixture-image', run: async () => { throw new Error('container removal failed') } }
  const preparer = new ContainerExecutionPreparer({ dataRoot: root, command: 'node', args: [], defaultModel: { provider: 'deepseek-official', model: 'fixture', upstream: { baseUrl: 'https://example.test' } } }, process, { directory: () => root }, artifacts)
  try {
    const published = await artifacts.stage(); await writeFile(join(published.directory, 'dependency'), 'still mounted')
    const prepared = await artifacts.publish(published, 'v1', 'identity', '')
    const interrupted = await artifacts.stage(); await writeFile(join(interrupted.directory, 'partial'), 'still preparing')
    await preparer.collect([])
    expect(await readFile(join(artifacts.directory(prepared.id), 'dependency'), 'utf8')).toBe('still mounted')
    expect(await readFile(join(interrupted.directory, 'partial'), 'utf8')).toBe('still preparing')
    await preparer.recover(); await preparer.collect([])
    expect(await readdir(join(root, 'artifacts'))).toEqual([])
  } finally { await artifacts.collect([]); await rm(root, { recursive: true, force: true }) }
})
