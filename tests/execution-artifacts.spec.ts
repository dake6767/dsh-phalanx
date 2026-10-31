import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { FileExecutionArtifacts } from '../src/adapters/execution-artifacts.js'
import { RuntimeDependencyPreparer } from '../src/adapters/runtime-dependency-preparer.js'
import { FileCommunityMaintenance } from '../src/adapters/community-maintenance.js'

it('preserves published execution trees and unfinished stages while the maintenance marker exists', async () => {
  const root = await mkdtemp(join(tmpdir(), 'execution-maintenance-')),
    marker = join(root, 'maintenance'),
    maintenance = new FileCommunityMaintenance(marker),
    artifacts = new FileExecutionArtifacts(join(root, 'artifacts'), () => !maintenance.closed())
  try {
    const old = await artifacts.stage()
    await writeFile(join(old.directory, 'value'), 'old retained tree')
    await artifacts.publish(old, 'v1', 'identity', '')
    const stage = await artifacts.stage()
    await writeFile(join(stage.directory, 'value'), 'unfinished preparation')
    await writeFile(marker, 'closed')
    await artifacts.collect([])
    await artifacts.discard(stage)
    expect(await readFile(join(old.directory, 'value'), 'utf8')).toBe('old retained tree')
    expect(await readFile(join(stage.directory, 'value'), 'utf8')).toBe('unfinished preparation')
    await rm(marker)
    await artifacts.collect([])
    expect(await readdir(join(root, 'artifacts'))).toEqual([])
  } finally {
    await rm(marker, { force: true })
    await artifacts.collect([])
    await rm(root, { recursive: true, force: true })
  }
})

it('freezes complete prepared trees by content and preserves older published dependencies', async () => {
  const root = await mkdtemp(join(tmpdir(), 'execution-artifacts-')),
    artifacts = new FileExecutionArtifacts(root)
  try {
    const first = await artifacts.stage()
    await mkdir(join(first.directory, 'deps'))
    await writeFile(join(first.directory, 'deps/value'), 'first')
    const one = await artifacts.publish(first, 'v1', 'identity', 'log')
    expect((await stat(join(artifacts.directory(one.id), 'deps/value'))).mode & 0o222).toBe(0)
    const second = await artifacts.stage()
    await mkdir(join(second.directory, 'deps'))
    await writeFile(join(second.directory, 'deps/value'), 'second')
    const two = await artifacts.publish(second, 'v1', 'identity', 'log')
    expect(two.hash).not.toBe(one.hash)
    expect(await readFile(join(artifacts.directory(one.id), 'deps/value'), 'utf8')).toBe('first')
    expect(await readFile(join(artifacts.directory(two.id), 'deps/value'), 'utf8')).toBe('second')
    const interrupted = await artifacts.stage()
    await writeFile(join(interrupted.directory, 'partial'), 'unfinished')
    await artifacts.collect([two.id])
    await expect(stat(interrupted.directory)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(artifacts.directory(one.id))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(join(artifacts.directory(two.id), 'deps/value'), 'utf8')).toBe('second')
  } finally {
    await artifacts.collect([])
    await rm(root, { recursive: true, force: true })
  }
})

it('retains stages and published artifacts after container cleanup failure until recovery succeeds', async () => {
  const root = await mkdtemp(join(tmpdir(), 'execution-cleanup-')),
    artifacts = new FileExecutionArtifacts(join(root, 'artifacts'))
  let safe = false
  const process = {
    isolated: true,
    get canDiscardArtifacts() {
      return safe
    },
    recover: async () => {
      safe = true
    },
    imageIdentity: async () => 'fixture-image',
    run: async () => {
      throw new Error('container removal failed')
    },
  }
  const preparer = new RuntimeDependencyPreparer(process, artifacts)
  try {
    const published = await artifacts.stage()
    await writeFile(join(published.directory, 'dependency'), 'still mounted')
    const prepared = await artifacts.publish(published, 'v1', 'identity', '')
    const interrupted = await artifacts.stage()
    await writeFile(join(interrupted.directory, 'partial'), 'still preparing')
    await preparer.collect([])
    expect(await readFile(join(artifacts.directory(prepared.id), 'dependency'), 'utf8')).toBe('still mounted')
    expect(await readFile(join(interrupted.directory, 'partial'), 'utf8')).toBe('still preparing')
    await preparer.recover()
    await preparer.collect([])
    expect(await readdir(join(root, 'artifacts'))).toEqual([])
  } finally {
    await artifacts.collect([])
    await rm(root, { recursive: true, force: true })
  }
})
