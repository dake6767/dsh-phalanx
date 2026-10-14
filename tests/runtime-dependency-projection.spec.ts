import { mkdtemp, readlink, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { FileRuntimeDependencyProjection } from '../src/adapters/runtime-dependency-projection.js'
import type { RuntimeDependencyVersion } from '../src/domain/runtime-dependency.js'
it('atomically switches command links and retains old generations while a member carrier can still use them', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dependency-projection-'))
  const version = (digit: string): RuntimeDependencyVersion => ({ id: digit.repeat(64), identity: digit, directory: '/host', mountedPath: '/fixed/' + digit, pathDirectories: ['empty-first', 'bin'], commands: ['example'], commandPaths: { example: 'bin/example' }, bytes: 1, isolated: true, checks: [], log: '' })
  let versions = [version('a')], active = true
  const projection = new FileRuntimeDependencyProjection(root, () => versions, () => active)
  try {
    await projection.prepare('member'); expect(await readlink(join(root, 'member/dependencies/live/example'))).toBe('/fixed/a/bin/example')
    versions = [version('b')]; await projection.prepare('member')
    expect(await readlink(join(root, 'member/dependencies/live/example'))).toBe('/fixed/b/bin/example')
    expect(await projection.retained()).toEqual(expect.arrayContaining(['a'.repeat(64), 'b'.repeat(64)]))
    versions = []; await projection.prepare('member'); expect(await readdir(join(root, 'member/dependencies/live'))).toEqual([])
    expect(await projection.retained()).toHaveLength(2)
    active = false; expect(await projection.retained()).toEqual([])
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('serializes reclamation with publication and member removal, retaining carriers still in use', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dependency-projection-race-'))
  const version = (digit: string): RuntimeDependencyVersion => ({ id: digit.repeat(64), identity: digit, directory: '/host', mountedPath: '/fixed/' + digit, pathDirectories: ['bin'], commands: ['example'], commandPaths: { example: 'bin/example' }, bytes: 1, isolated: true, checks: [], log: '' })
  let versions = [version('a')], active = false
  const projection = new FileRuntimeDependencyProjection(root, () => versions, () => active)
  let enter!: () => void, release!: () => void
  const entered = new Promise<void>(resolve => { enter = resolve }), gate = new Promise<void>(resolve => { release = resolve })
  const boundary = projection as unknown as { entries(path: string): Promise<string[]> }
  const original = boundary.entries.bind(projection)
  const spy = vi.spyOn(boundary, 'entries')
  try {
    await projection.prepare('member')
    let paused = false
    spy.mockImplementation(async path => {
      if (path === join(root, 'member/dependencies') && !paused) { paused = true; enter(); await gate }
      return original(path)
    })
    const collect = projection.retained(); await entered
    versions = [version('b')]
    const publish = projection.prepare('member')
    release(); await Promise.all([collect, publish])
    expect(await readlink(join(root, 'member/dependencies/live/example'))).toBe('/fixed/b/bin/example')
    expect(await projection.retained()).toEqual(['b'.repeat(64)])
    active = true
    const remove = vi.fn(async () => { await rm(join(root, 'member'), { recursive: true, force: true }) })
    await projection.removeMember('member', remove); expect(remove).not.toHaveBeenCalled()
    active = false; await projection.removeMember('member', remove); expect(remove).toHaveBeenCalledOnce()
    expect(await projection.retained()).toEqual([])
  } finally { release(); spy.mockRestore(); await rm(root, { recursive: true, force: true }) }
})
