import { expect, it } from 'vitest'
import { NativePluginDownloads } from '../src/use-cases/native-plugin-downloads.js'
import { SignedPluginDownloadTokens } from '../src/adapters/plugin-download-tokens.js'

it('binds retained checked bytes to the current member and permits an unpublished preinstall', () => {
  const actor = { username: 'alice', spaceId: 'alice-space', sessionEpoch: 1 }
  const account = { ...actor, admin: false, disabled: false, groupId: 'ordinary', email: '', createdAt: 0, updatedAt: 0 }
  const plugin = { packageName: 'sample', version: '1.0.0', artifact: 'artifacts/checked', integrity: 'sha512-checked', runtimeRevision: 'runtime', title: 'Sample', description: '', bundlePatch: '[]', dependencies: {} }
  const downloads = new NativePluginDownloads({ get: name => name === 'alice' ? account : undefined }, { list: () => [{ ...plugin, current: plugin, published: false, stage: 'available' }] }, new SignedPluginDownloadTokens('native-download-fixture-secret'), { now: () => 1000 }, 'runtime')
  const issued = downloads.issue(actor, 'sample')
  expect(issued.url).toMatch(/^http:\/\/plugins\.dsh-phalanx\.invalid\/plugin-archive\/.+\.tgz$/u)
  const token = new URL(issued.url).pathname.slice('/plugin-archive/'.length, -4)
  expect(downloads.read(token, 'alice')).toEqual(plugin)
  expect(() => downloads.read(token, 'bob')).toThrow()
})

it('rejects expiry, revoked account identity, stale bytes and incompatible or removing entries', () => {
  const actor = { username: 'alice', spaceId: 'alice-space', sessionEpoch: 1 }
  let account = { ...actor, admin: false, disabled: false, groupId: 'ordinary', email: '', createdAt: 0, updatedAt: 0 }, now = 1000
  const plugin = { packageName: 'sample', version: '1.0.0', artifact: 'artifacts/checked', integrity: 'sha512-checked', runtimeRevision: 'runtime', title: 'Sample', description: '', bundlePatch: '[]', dependencies: {} }
  let row = { ...plugin, current: plugin, published: false, stage: 'available' as const, removing: false, incompatible: false }
  const tokens = new SignedPluginDownloadTokens('native-download-fixture-secret')
  const downloads = new NativePluginDownloads({ get: () => account }, { list: () => [row] }, tokens, { now: () => now }, 'runtime')
  const token = new URL(downloads.issue(actor, 'sample').url).pathname.slice('/plugin-archive/'.length, -4)
  expect(() => downloads.read(token + 'x', 'alice')).toThrow()
  now = 61000; expect(() => downloads.read(token, 'alice')).toThrow(); now = 1000
  account = { ...account, disabled: true }; expect(() => downloads.issue(actor, 'sample')).toThrow(); expect(() => downloads.read(token, 'alice')).toThrow()
  account = { ...account, disabled: false, sessionEpoch: 2 }; expect(() => downloads.read(token, 'alice')).toThrow()
  account = { ...account, sessionEpoch: 1, spaceId: 'replaced' }; expect(() => downloads.read(token, 'alice')).toThrow()
  account = { ...account, spaceId: actor.spaceId }
  for (const change of [{ integrity: 'sha512-other' }, { artifact: 'artifacts/other' }, { runtimeRevision: 'other' }]) {
    row = { ...row, current: { ...plugin, ...change } }; expect(() => downloads.read(token, 'alice')).toThrow()
  }
  row = { ...row, current: plugin, incompatible: true }; expect(() => downloads.issue(actor, 'sample')).toThrow()
  row = { ...row, incompatible: false, removing: true }; expect(() => downloads.read(token, 'alice')).toThrow()
})
