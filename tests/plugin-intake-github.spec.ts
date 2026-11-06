import { expect, it } from 'vitest'
import type { CommunityPluginView } from '../src/domain/admin-contract.js'
import { PluginIntake } from '../src/use-cases/plugin-intake.js'

const actor = { username: 'admin', spaceId: 'space-admin', sessionEpoch: 1 }
const commit = 'a'.repeat(40)

it('keeps a GitHub archive that confirmation is adopting even when the preview expires meanwhile', async () => {
  let now = 0
  const discarded: string[] = []
  let adopting!: () => void
  const entered = new Promise<void>(resolve => (adopting = resolve))
  let finish!: (view: CommunityPluginView) => void
  const adopted = new Promise<CommunityPluginView>(resolve => (finish = resolve))
  let tokens = 0
  const intake = new PluginIntake(
    { get: async () => ({ ...actor, admin: true, disabled: false }) as never },
    { resolve: async () => ({ packageName: 'unused', version: '1.0.0' }) },
    {
      prepare: async input => ({
        packageName: input.packageName,
        version: input.version,
        integrity: input.upload!.integrity,
        artifact: 'artifacts/fixture',
        runtimeRevision: 'fixture',
        title: '',
        description: '',
        bundlePatch: '[]',
        dependencies: {},
      }),
    },
    async () => {},
    async () => {
      adopting()
      return adopted
    },
    { now: () => now },
    () => `token-${++tokens}`,
    {
      resolve: async repository => ({ repository, commit }),
      pack: async () => ({ packageName: 'plugin', version: '1.0.0', archive: '/archives/one.tgz', integrity: 'sha512-fixture' }),
      discard: async archive => {
        discarded.push(archive)
      },
    },
  )
  const started = await intake.create(actor, 'github:owner/repo')
  await expect.poll(async () => (await intake.read(actor, started.token)).stage).toBe('ready')
  expect(await intake.read(actor, started.token)).toMatchObject({ source: 'github', repository: 'owner/repo', sourceCommit: commit })
  const confirming = intake.confirm(actor, started.token)
  await entered
  now += 31 * 60 * 1000
  // A concurrent poll expires the preview while adoption is still saving the library row.
  await expect(intake.read(actor, started.token)).rejects.toMatchObject({ code: 'plugin-preview-unavailable' })
  await new Promise(resolve => setTimeout(resolve, 10))
  expect(discarded).toEqual([])
  finish({ packageName: 'plugin' } as CommunityPluginView)
  await expect(confirming).resolves.toMatchObject({ packageName: 'plugin' })
  await intake.stop()
  expect(discarded).toEqual([])
})

it('releases the archive when adoption fails after the preview expired', async () => {
  let now = 0
  const discarded: string[] = []
  let adopting!: () => void
  const entered = new Promise<void>(resolve => (adopting = resolve))
  let fail!: (error: Error) => void
  const adopted = new Promise<CommunityPluginView>((_, reject) => (fail = reject))
  const intake = new PluginIntake(
    { get: async () => ({ ...actor, admin: true, disabled: false }) as never },
    { resolve: async () => ({ packageName: 'unused', version: '1.0.0' }) },
    {
      prepare: async input => ({
        packageName: input.packageName,
        version: input.version,
        integrity: input.upload!.integrity,
        artifact: 'artifacts/fixture',
        runtimeRevision: 'fixture',
        title: '',
        description: '',
        bundlePatch: '[]',
        dependencies: {},
      }),
    },
    async () => {},
    async () => {
      adopting()
      return adopted
    },
    { now: () => now },
    () => 'token',
    {
      resolve: async repository => ({ repository, commit }),
      pack: async () => ({ packageName: 'plugin', version: '1.0.0', archive: '/archives/two.tgz', integrity: 'sha512-fixture' }),
      discard: async archive => {
        discarded.push(archive)
      },
    },
  )
  const started = await intake.create(actor, 'github:owner/repo')
  await expect.poll(async () => (await intake.read(actor, started.token)).stage).toBe('ready')
  const confirming = intake.confirm(actor, started.token)
  await entered
  now += 31 * 60 * 1000
  await expect(intake.read(actor, started.token)).rejects.toMatchObject({ code: 'plugin-preview-unavailable' })
  fail(new Error('store unavailable'))
  await expect(confirming).rejects.toThrow('store unavailable')
  expect(discarded).toEqual(['/archives/two.tgz'])
})
