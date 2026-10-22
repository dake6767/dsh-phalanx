import { expect, it } from 'vitest'
import { BusinessRuleError } from '../src/domain/business-error.js'
import { MemberNativePluginJobs } from '../src/use-cases/member-native-plugin-jobs.js'
import { MemberNativePlugins } from '../src/use-cases/member-native-plugins.js'
import { NativePluginDownloads } from '../src/use-cases/native-plugin-downloads.js'
import type { PluginInstallation } from '../src/ports/plugin-installations.js'

it('keeps accepted installation alive independently of the requesting page and records only its successful result', async () => {
  const account = { username: 'alice', spaceId: 'space-a', sessionEpoch: 0, disabled: false, email: '', admin: false, groupId: 'members', createdAt: 0, updatedAt: 0 }
  const accounts = { get: () => account }
  const actor = { username: account.username, spaceId: account.spaceId, sessionEpoch: account.sessionEpoch }
  const plugin = { packageName: 'sample', version: '1.0.0', integrity: 'sha512-fixture', artifact: 'artifacts/fixture', runtimeRevision: 'revision', title: 'Sample', description: '', bundlePatch: '[]', dependencies: {} }
  const downloads = new NativePluginDownloads(accounts, { list: () => [{ ...plugin, current: plugin, stage: 'available', published: true }] }, { issue: () => 'signed', read: () => undefined }, { now: () => 0 }, 'revision')
  let finish!: () => void, entered!: () => void
  const started = new Promise<void>(resolve => { entered = resolve }), completed = new Promise<void>(resolve => { finish = resolve })
  const native = new MemberNativePlugins(accounts, downloads, { list: async () => [], install: async (_instance, _origin, _archive, options, signal) => {
    options.progress?.('downloading'); entered(); await completed; signal.throwIfAborted(); options.progress?.('installing'); return 'restart-required'
  }, remove: async () => 'applied' }, { current: () => ({ npm: 'https://registry.npmjs.org' }) })
  let history: readonly PluginInstallation[] = []
  const records = { get: () => history, save: (_space: string, row: PluginInstallation) => { history = [row] } }
  const jobs = new MemberNativePluginJobs(accounts, { ensure: async () => ({ userId: 'alice', processId: 1, origin: 'http://localhost', launchUrl: 'http://localhost' }) }, native, records)
  const origin = new URL('http://localhost')
  const accepted = jobs.install(actor, 'sample', origin, 'request-1')
  expect(accepted).toMatchObject({ requestId: 'request-1', status: 'running' })
  await started
  expect(jobs.get(actor, 'sample')).toMatchObject({ phase: 'downloading', status: 'running' })
  expect(history).toEqual([])
  expect(jobs.install(actor, 'sample', origin, 'request-1')).toEqual(jobs.get(actor, 'sample'))
  expect(() => jobs.install(actor, 'other', origin, 'request-1')).toThrow()
  finish(); await jobs.drain()
  expect(jobs.get(actor, 'sample')).toMatchObject({ requestId: 'request-1', status: 'succeeded', application: 'restart-required' })
  expect(records.get()).toEqual([{ packageName: 'sample', source: 'selected', version: '1.0.0' }])
  expect(jobs.get(actor, 'sample', { userId: 'alice', processId: 2, origin: 'http://localhost', launchUrl: 'http://localhost' })).toMatchObject({ application: 'applied' })
  await jobs.stop()
})

it('retains prior successful history on failure, permits a fresh retry, and never changes history on removal', async () => {
  const account = { username: 'alice', spaceId: 'space-a', sessionEpoch: 0, disabled: false, email: '', admin: false, groupId: 'g', createdAt: 0, updatedAt: 0 }, accounts = { get: () => account }
  const plugin = { packageName: 'sample', version: '2.0.0', integrity: 'sha512-fixture', artifact: 'artifacts/fixture', runtimeRevision: 'revision', title: '', description: '', bundlePatch: '[]', dependencies: {} }
  const downloads = new NativePluginDownloads(accounts, { list: () => [{ ...plugin, current: plugin, stage: 'available', published: true }] }, { issue: () => 'signed', read: () => undefined }, { now: () => 0 }, 'revision')
  let fail = true, history: readonly PluginInstallation[] = [{ packageName: 'sample', source: 'preinstall', version: '1.0.0' }]
  const native = new MemberNativePlugins(accounts, downloads, { list: async () => [], install: async () => {
    if (fail) throw new BusinessRuleError('conflict', 'Build scripts are blocked.', 'plugin-install-failed', { reason: 'build-blocked' })
    return 'applied'
  }, remove: async () => 'applied' }, { current: () => ({ npm: 'https://registry.npmjs.org' }) })
  const jobs = new MemberNativePluginJobs(accounts, { ensure: async () => ({ userId: 'alice', processId: 1, origin: 'http://localhost', launchUrl: 'http://localhost' }) }, native,
    { get: () => history, save: (_space, row) => { history = [row] } })
  const origin = new URL('http://localhost'), actor = { username: 'alice', spaceId: 'space-a', sessionEpoch: 0 }
  jobs.install(actor, 'sample', origin, 'failed'); await jobs.drain()
  expect(jobs.get(actor, 'sample')).toMatchObject({ status: 'failed', failure: { code: 'plugin-install-failed', params: { reason: 'build-blocked' } } })
  expect(history).toEqual([{ packageName: 'sample', source: 'preinstall', version: '1.0.0' }])
  fail = false; jobs.install(actor, 'sample', origin, 'retry'); await jobs.drain()
  expect(jobs.get(actor, 'sample')).toMatchObject({ status: 'succeeded' })
  expect(history).toEqual([{ packageName: 'sample', source: 'selected', version: '2.0.0' }])
  jobs.remove(actor, 'sample', origin, 'remove'); await jobs.drain()
  expect(history).toEqual([{ packageName: 'sample', source: 'selected', version: '2.0.0' }])
  account.spaceId = 'replacement'; expect(() => jobs.get(actor, 'sample')).toThrow()
  expect(jobs.get({ ...actor, spaceId: 'replacement' }, 'sample')).toBeUndefined()
  await jobs.stop(); expect(() => jobs.install({ ...actor, spaceId: 'replacement' }, 'sample', origin, 'stopped')).toThrow()
})
