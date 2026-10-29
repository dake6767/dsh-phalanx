import { expect, it } from 'vitest'
import { MemberNativePlugins } from '../src/use-cases/member-native-plugins.js'
import { NativePluginDownloads } from '../src/use-cases/native-plugin-downloads.js'
import { SignedPluginDownloadTokens } from '../src/adapters/plugin-download-tokens.js'
import type { MemberNativePluginManagerPort } from '../src/ports/member-native-plugins.js'

it('installs retained bytes with this call’s registry and removes the native copy independently of the shelf', async () => {
  const actor = { username: 'alice', spaceId: 'alice-space', sessionEpoch: 1 }
  const account = { ...actor, admin: false, disabled: false, groupId: 'ordinary', email: '', createdAt: 0, updatedAt: 0 }
  const plugin = {
    packageName: 'sample',
    version: '1.0.0',
    artifact: 'artifacts/checked',
    integrity: 'sha512-checked',
    runtimeRevision: 'runtime',
    title: 'Sample',
    description: '',
    bundlePatch: '[]',
    dependencies: {},
  }
  let onShelf = true,
    installed = false
  const accounts = { get: async () => account }
  const downloads = new NativePluginDownloads(
    accounts,
    { list: async () => (onShelf ? [{ ...plugin, current: plugin, published: false, stage: 'available' }] : []) },
    new SignedPluginDownloadTokens('native-install-fixture-secret'),
    { now: () => 1000 },
    'runtime',
  )
  const manager: MemberNativePluginManagerPort = {
    list: async () => (installed ? [{ packageName: 'sample', version: '1.0.0' }] : []),
    install: async (_instance, _origin, archive, options) => {
      expect(archive.integrity).toBe(plugin.integrity)
      expect(archive.url).toContain('http://plugins.dsh-phalanx.invalid/plugin-archive/')
      expect(options).toEqual({ registry: 'https://registry.npmmirror.com', requestId: 'install-1' })
      installed = true
      return 'restart-required'
    },
    remove: async (_instance, _origin, name) => {
      expect(name).toBe('sample')
      installed = false
      return 'applied'
    },
  }
  const native = new MemberNativePlugins(accounts, downloads, manager, { current: () => ({ npm: 'https://registry.npmmirror.com' }) })
  const instance = { userId: 'alice', origin: 'http://runtime.test', launchUrl: 'http://runtime.test/launch', processId: 1 },
    origin = new URL('http://platform.test'),
    signal = new AbortController().signal
  expect(await native.install(actor, 'sample', instance, origin, signal, 'install-1')).toMatchObject({ application: 'restart-required', version: '1.0.0' })
  await expect(native.install(actor, 'sample', instance, origin, signal, 'install-2')).rejects.toMatchObject({ code: 'plugin-market-unavailable' })
  onShelf = false
  expect(await native.remove(actor, 'sample', instance, origin, signal)).toBe('applied')
  expect(installed).toBe(false)
})

it('rechecks member identity and checked artifact after asynchronous native inventory', async () => {
  const actor = { username: 'alice', spaceId: 'space', sessionEpoch: 1 }
  let disabled = false,
    integrity = 'sha512-original'
  const accounts = { get: async () => ({ ...actor, admin: false, disabled, groupId: 'ordinary', email: '', createdAt: 0, updatedAt: 0 }) }
  const library = {
    list: async () => {
      const plugin = {
        packageName: 'sample',
        version: '1.0.0',
        artifact: 'artifacts/original',
        integrity,
        runtimeRevision: 'runtime',
        title: '',
        description: '',
        bundlePatch: '[]',
        dependencies: {},
      }
      return [{ ...plugin, current: plugin, stage: 'available' as const, published: true }]
    },
  }
  const downloads = new NativePluginDownloads(
    accounts,
    library,
    new SignedPluginDownloadTokens('native-recheck-fixture-secret'),
    { now: () => 1000 },
    'runtime',
  )
  let change = () => {
    disabled = true
  }
  const manager: MemberNativePluginManagerPort = {
    list: async () => {
      change()
      return []
    },
    install: async () => {
      throw Error('must not install')
    },
    remove: async () => {
      throw Error('must not remove')
    },
  }
  const native = new MemberNativePlugins(accounts, downloads, manager, { current: () => ({ npm: 'https://registry.npmjs.org' }) })
  const instance = { userId: 'alice', origin: 'http://runtime.test', launchUrl: 'http://runtime.test/launch', processId: 1 },
    origin = new URL('http://platform.test')
  await expect(native.install(actor, 'sample', instance, origin, new AbortController().signal, 'first')).rejects.toMatchObject({ code: 'sign-in-required' })
  disabled = false
  change = () => {
    integrity = 'sha512-replacement'
  }
  await expect(native.install(actor, 'sample', instance, origin, new AbortController().signal, 'second')).rejects.toMatchObject({
    code: 'plugin-market-unavailable',
  })
  await expect(native.remove(actor, 'sample', { ...instance, userId: 'bob' }, origin, new AbortController().signal)).rejects.toMatchObject({
    code: 'sign-in-required',
  })
})
