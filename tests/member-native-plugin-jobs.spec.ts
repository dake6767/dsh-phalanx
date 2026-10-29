import { expect, it } from 'vitest'
import { BusinessRuleError } from '../src/domain/business-error.js'
import { MemberNativePluginJobs } from '../src/use-cases/member-native-plugin-jobs.js'
import { MemberNativePlugins } from '../src/use-cases/member-native-plugins.js'
import { NativePluginDownloads } from '../src/use-cases/native-plugin-downloads.js'
import type { PluginInstallation } from '../src/ports/plugin-installations.js'
import type { CommunityUserInstance } from '../src/ports/community-runtime.js'

const preinstallFixture = () => {
  const account = {
      username: 'alice',
      spaceId: 'space-a',
      sessionEpoch: 0,
      disabled: false,
      email: '',
      admin: false,
      groupId: 'members',
      createdAt: 0,
      updatedAt: 0,
    },
    accounts = { get: async () => account }
  const plugin = {
    packageName: 'sample',
    version: '1.0.0',
    integrity: 'sha512-fixture',
    artifact: 'artifacts/fixture',
    runtimeRevision: 'revision',
    title: '',
    description: '',
    bundlePatch: '[]',
    dependencies: {},
  }
  const downloads = new NativePluginDownloads(
    accounts,
    { list: async () => [{ ...plugin, current: plugin, stage: 'available', published: false }] },
    { issue: () => 'signed', read: () => undefined },
    { now: () => 0 },
    'revision',
  )
  let finish!: () => void,
    entered!: () => void,
    present = false
  const started = new Promise<void>(resolve => {
      entered = resolve
    }),
    completed = new Promise<void>(resolve => {
      finish = resolve
    })
  const native = new MemberNativePlugins(
    accounts,
    downloads,
    {
      list: async () => (present ? [{ packageName: 'sample' }] : []),
      install: async () => {
        entered()
        await completed
        return 'restart-required'
      },
      remove: async () => 'applied',
    },
    { current: () => ({ npm: 'https://registry.npmjs.org' }) },
  )
  const history: PluginInstallation[] = [],
    instance: CommunityUserInstance = { userId: 'alice', processId: 1, origin: 'http://localhost', launchUrl: 'http://localhost' }
  const jobs = new MemberNativePluginJobs(
    accounts,
    {
      ensure: async () => {
        throw Error('Ready preinstallation must not ensure recursively')
      },
    },
    native,
    {
      get: async () => history,
      save: async (_space, row) => {
        history.push(row)
      },
    },
  )
  return {
    plugin,
    account,
    jobs,
    instance,
    history,
    started,
    finish: () => {
      finish()
    },
    installed: () => {
      present = true
    },
    actor: { username: account.username, spaceId: account.spaceId, sessionEpoch: account.sessionEpoch },
    origin: new URL('http://localhost'),
  }
}

it('delivers preinstalls on the captured ready carrier and records restart-required as successful preinstallation', async () => {
  const f = preinstallFixture()
  const task = f.jobs.preinstall(f.actor, f.plugin, f.instance, f.origin, async () => true)
  await f.started
  expect(f.history).toEqual([])
  await expect(f.jobs.install(f.actor, 'sample', f.origin, 'manual')).rejects.toThrow()
  f.finish()
  expect(await task).toBe('succeeded')
  expect(f.history).toEqual([{ packageName: 'sample', source: 'preinstall', version: '1.0.0' }])
  await f.jobs.stop()
})

it('skips independent native copies without inventing delivery history and drains cancelled space work before reset', async () => {
  const existing = preinstallFixture()
  existing.installed()
  expect(await existing.jobs.preinstall(existing.actor, existing.plugin, existing.instance, existing.origin, async () => true)).toBe('skipped')
  expect(existing.history).toEqual([])
  await existing.jobs.stop()
  const f = preinstallFixture()
  const task = f.jobs.preinstall(f.actor, f.plugin, f.instance, f.origin, async () => true)
  await f.started
  const cancelled = f.jobs.cancelSpace(f.actor.spaceId)
  f.finish()
  await cancelled
  expect(await task).toBe('cancelled')
  expect(f.history).toEqual([])
  await f.jobs.stop()
})

it('keeps accepted installation alive independently of the requesting page and records only its successful result', async () => {
  const account = {
    username: 'alice',
    spaceId: 'space-a',
    sessionEpoch: 0,
    disabled: false,
    email: '',
    admin: false,
    groupId: 'members',
    createdAt: 0,
    updatedAt: 0,
  }
  const accounts = { get: async () => account }
  const actor = { username: account.username, spaceId: account.spaceId, sessionEpoch: account.sessionEpoch }
  const plugin = {
    packageName: 'sample',
    version: '1.0.0',
    integrity: 'sha512-fixture',
    artifact: 'artifacts/fixture',
    runtimeRevision: 'revision',
    title: 'Sample',
    description: '',
    bundlePatch: '[]',
    dependencies: {},
  }
  const downloads = new NativePluginDownloads(
    accounts,
    { list: async () => [{ ...plugin, current: plugin, stage: 'available', published: true }] },
    { issue: () => 'signed', read: () => undefined },
    { now: () => 0 },
    'revision',
  )
  let finish!: () => void, entered!: () => void
  const started = new Promise<void>(resolve => {
      entered = resolve
    }),
    completed = new Promise<void>(resolve => {
      finish = resolve
    })
  const native = new MemberNativePlugins(
    accounts,
    downloads,
    {
      list: async () => [],
      install: async (_instance, _origin, _archive, options, signal) => {
        options.progress?.('downloading')
        entered()
        await completed
        signal.throwIfAborted()
        options.progress?.('installing')
        return 'restart-required'
      },
      remove: async () => 'applied',
    },
    { current: () => ({ npm: 'https://registry.npmjs.org' }) },
  )
  let history: readonly PluginInstallation[] = []
  const records = {
    get: async () => history,
    save: async (_space: string, row: PluginInstallation) => {
      history = [row]
    },
  }
  const jobs = new MemberNativePluginJobs(
    accounts,
    { ensure: async () => ({ userId: 'alice', processId: 1, origin: 'http://localhost', launchUrl: 'http://localhost' }) },
    native,
    records,
  )
  const origin = new URL('http://localhost')
  const accepted = await jobs.install(actor, 'sample', origin, 'request-1')
  expect(accepted).toMatchObject({ requestId: 'request-1', status: 'running' })
  await started
  expect(await jobs.get(actor, 'sample')).toMatchObject({ phase: 'downloading', status: 'running' })
  expect(history).toEqual([])
  expect(await jobs.install(actor, 'sample', origin, 'request-1')).toEqual(await jobs.get(actor, 'sample'))
  await expect(jobs.install(actor, 'other', origin, 'request-1')).rejects.toThrow()
  finish()
  await jobs.drain()
  expect(await jobs.get(actor, 'sample')).toMatchObject({ requestId: 'request-1', status: 'succeeded', application: 'restart-required' })
  expect(await records.get()).toEqual([{ packageName: 'sample', source: 'selected', version: '1.0.0' }])
  expect(await jobs.get(actor, 'sample', { userId: 'alice', processId: 2, origin: 'http://localhost', launchUrl: 'http://localhost' })).toMatchObject({
    application: 'applied',
  })
  await jobs.stop()
})

it('retains prior successful history on failure, permits a fresh retry, and never changes history on removal', async () => {
  const account = {
      username: 'alice',
      spaceId: 'space-a',
      sessionEpoch: 0,
      disabled: false,
      email: '',
      admin: false,
      groupId: 'g',
      createdAt: 0,
      updatedAt: 0,
    },
    accounts = { get: async () => account }
  const plugin = {
    packageName: 'sample',
    version: '2.0.0',
    integrity: 'sha512-fixture',
    artifact: 'artifacts/fixture',
    runtimeRevision: 'revision',
    title: '',
    description: '',
    bundlePatch: '[]',
    dependencies: {},
  }
  const downloads = new NativePluginDownloads(
    accounts,
    { list: async () => [{ ...plugin, current: plugin, stage: 'available', published: true }] },
    { issue: () => 'signed', read: () => undefined },
    { now: () => 0 },
    'revision',
  )
  let fail = true,
    history: readonly PluginInstallation[] = [{ packageName: 'sample', source: 'preinstall', version: '1.0.0' }]
  const native = new MemberNativePlugins(
    accounts,
    downloads,
    {
      list: async () => [],
      install: async () => {
        if (fail) throw new BusinessRuleError('conflict', 'Build scripts are blocked.', 'plugin-install-failed', { reason: 'build-blocked' })
        return 'applied'
      },
      remove: async () => 'applied',
    },
    { current: () => ({ npm: 'https://registry.npmjs.org' }) },
  )
  const jobs = new MemberNativePluginJobs(
    accounts,
    { ensure: async () => ({ userId: 'alice', processId: 1, origin: 'http://localhost', launchUrl: 'http://localhost' }) },
    native,
    {
      get: async () => history,
      save: async (_space, row) => {
        history = [row]
      },
    },
  )
  const origin = new URL('http://localhost'),
    actor = { username: 'alice', spaceId: 'space-a', sessionEpoch: 0 }
  await jobs.install(actor, 'sample', origin, 'failed')
  await jobs.drain()
  expect(await jobs.get(actor, 'sample')).toMatchObject({ status: 'failed', failure: { code: 'plugin-install-failed', params: { reason: 'build-blocked' } } })
  expect(history).toEqual([{ packageName: 'sample', source: 'preinstall', version: '1.0.0' }])
  fail = false
  await jobs.install(actor, 'sample', origin, 'retry')
  await jobs.drain()
  expect(await jobs.get(actor, 'sample')).toMatchObject({ status: 'succeeded' })
  expect(history).toEqual([{ packageName: 'sample', source: 'selected', version: '2.0.0' }])
  await jobs.remove(actor, 'sample', origin, 'remove')
  await jobs.drain()
  expect(history).toEqual([{ packageName: 'sample', source: 'selected', version: '2.0.0' }])
  account.spaceId = 'replacement'
  await expect(jobs.get(actor, 'sample')).rejects.toThrow()
  expect(await jobs.get({ ...actor, spaceId: 'replacement' }, 'sample')).toBeUndefined()
  await jobs.stop()
  await expect(jobs.install({ ...actor, spaceId: 'replacement' }, 'sample', origin, 'stopped')).rejects.toThrow()
})
