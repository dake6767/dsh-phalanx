import { expect, it, vi } from 'vitest'
import type { CatalogPluginServiceSlot } from '../src/domain/suite-service-slots.js'
import type { NativeServiceSettingsTransport } from '../src/ports/member-native-plugins.js'
import { nativeJsonSettingsHistoryKey, type PluginInstallation } from '../src/ports/plugin-installations.js'
import { MemberNativeServiceSettings } from '../src/use-cases/member-native-service-settings.js'

const actor = { username: 'member', spaceId: 'space', sessionEpoch: 0 }
const instance = { ...actor, userId: actor.username, origin: 'http://localhost:2345', launchUrl: 'http://localhost:2345/launch', processId: 42 }
const origin = new URL('http://platform.example')
const slot: CatalogPluginServiceSlot = {
  id: 'chat',
  label: { en: 'Chat', 'zh-CN': '对话' },
  binding: {
    kind: 'revisioned-rpc',
    service: 'nativeSettings',
    active: ['ai'],
    selection: ['chat'],
    profiles: ['profiles'],
    idKey: 'id',
    snapshotKey: 'snap',
    fields: { endpoint: 'url', key: 'key', model: 'model', mode: 'mode' },
  },
  backends: [
    {
      id: 'chat',
      label: { en: 'Chat', 'zh-CN': '对话' },
      protocol: 'openai-chat',
      mode: 'openai',
      upstream: { endpoint: 'url', key: 'key', model: 'model' },
      fields: [],
    },
  ],
}

it('persists an intent before native save and recovers a committed save after a lost reply without writing twice', async () => {
  let record: PluginInstallation = { packageName: 'native', source: 'selected', version: '1.0.0', integrity: 'digest', serviceOrigin: 'catalog' }
  const fingerprint = 'a'.repeat(64)
  const syncSettings = vi.fn<NativeServiceSettingsTransport['syncSettings']>()
  syncSettings
    .mockResolvedValueOnce({ status: 'prepared', fingerprint, observed: null, revision: 1 })
    .mockImplementationOnce(async (_instance, _origin, input) => {
      expect(input.phase).toBe('apply')
      expect(record.serviceSettings?.chat?.pending).toBe(fingerprint)
      throw new Error('The write response was lost')
    })
    .mockResolvedValueOnce({ status: 'applied', fingerprint, refresh: false })
  const settings = new MemberNativeServiceSettings(
    {
      get: async () => [record],
      replaceServiceSettings: async (_space, expected, next) => {
        if (record !== expected) return false
        record = { ...expected, serviceSettings: next }
        return true
      },
    },
    {
      installedServices: async () => ({
        revision: 'ready',
        configuration: {
          identity: { id: 'catalog', version: '1.0.0' },
          ownerVersion: 'digest',
          slots: [slot],
          settings: [{ slot: 'chat', backend: 'chat', enabled: true, values: { key: 'raw-provider-key' } }],
        },
      }),
    },
    {
      issue: async () => ({ token: 'member-scope', url: 'http://localhost/scoped', model: 'model', protocol: 'openai-chat' }),
      installedServiceOrigins: async () => new Map(),
    },
    { syncSettings },
  )
  expect(await settings.apply(actor, instance, 'native', origin)).toEqual([{ slot: 'chat', status: 'failed' }])
  expect(await settings.apply(actor, instance, 'native', origin)).toEqual([{ slot: 'chat', status: 'applied', refresh: true }])
  expect(record.serviceSettings?.chat).toEqual({ contract: expect.any(String), applied: fingerprint })
  expect(syncSettings).toHaveBeenCalledTimes(3)
  expect(syncSettings.mock.calls[2]?.[2].previous).toEqual([null, fingerprint])
  expect(JSON.stringify(syncSettings.mock.calls)).not.toContain('raw-provider-key')
  expect(JSON.stringify(record)).not.toContain('member-scope')
})

it('defers JSON bindings until the next entry and persists detached fields even when no write is needed', async () => {
  let record: PluginInstallation = { packageName: 'native', source: 'selected', version: '1.0.0', integrity: 'digest', serviceOrigin: 'catalog' }
  const jsonSlot: CatalogPluginServiceSlot = {
    ...slot,
    binding: {
      kind: 'json-settings',
      file: 'media-desk/settings.json',
      upstream: 'image',
      fields: [
        { path: ['image', 'baseUrl'], source: 'gateway-url' },
        { path: ['image', 'model'], source: 'model' },
        { path: ['image', 'apiKey'], source: 'service-token' },
      ],
    },
  }
  let filename = 'media-desk/settings.json'
  const fields = {
    'image.baseUrl': { applied: 'a'.repeat(64) },
    'image.model': { detached: true },
    'image.apiKey': { applied: 'b'.repeat(64) },
  } as const
  const pending = { ...fields, 'image.apiKey': { applied: null, pending: 'b'.repeat(64) } }
  const syncJsonSettings = vi.fn<NonNullable<NativeServiceSettingsTransport['syncJsonSettings']>>()
  syncJsonSettings.mockResolvedValueOnce({ status: 'prepared', revision: 'c'.repeat(64), fields: pending }).mockResolvedValueOnce({ status: 'applied', fields })
  const settings = new MemberNativeServiceSettings(
    {
      get: async () => [record],
      replaceServiceSettings: async (_space, expected, next) => {
        if (JSON.stringify(record) !== JSON.stringify(expected)) return false
        record = { ...expected, serviceSettings: next }
        return true
      },
    },
    {
      installedServices: async () => ({
        revision: 'ready',
        configuration: {
          identity: { id: 'catalog', version: '1.0.0' },
          ownerVersion: 'digest',
          slots: [jsonSlot.binding.kind === 'json-settings' ? { ...jsonSlot, binding: { ...jsonSlot.binding, file: filename } } : jsonSlot],
          settings: [{ slot: 'chat', backend: 'chat', enabled: true, values: {} }],
        },
      }),
    },
    {
      issue: async () => ({ token: 'member-scope', url: 'http://localhost/scoped', model: 'model', protocol: 'openai-image' }),
      installedServiceOrigins: async () => new Map(),
    },
    { syncSettings: vi.fn(), syncJsonSettings },
  )
  expect(await settings.apply(actor, instance, 'native', origin)).toEqual([{ slot: 'chat', status: 'pending', nextStart: true }])
  expect(syncJsonSettings).not.toHaveBeenCalled()
  await settings.ensureLaunch(actor, instance, origin)
  expect(syncJsonSettings.mock.calls.map(call => call[2].phase)).toEqual(['preview', 'apply'])
  expect(record.serviceSettings?.[nativeJsonSettingsHistoryKey]?.jsonFiles).toEqual({ 'media-desk/settings.json': fields })
  expect(JSON.stringify(record)).not.toContain('member-scope')
  expect(settings.view(instance, 'native')).toEqual([{ slot: 'chat', status: 'personal', nextStart: true }])

  filename = 'media-desk/replacement.json'
  syncJsonSettings.mockResolvedValueOnce({ status: 'applied', fields })
  await settings.ensureLaunch(actor, { ...instance, processId: 43 }, origin)
  expect(syncJsonSettings.mock.calls.at(-1)?.[2].previous).toEqual({})
  expect(Object.keys(record.serviceSettings?.[nativeJsonSettingsHistoryKey]?.jsonFiles ?? {})).toHaveLength(2)

  filename = 'media-desk/settings.json'
  syncJsonSettings.mockResolvedValueOnce({ status: 'applied', fields })
  await settings.ensureLaunch(actor, { ...instance, processId: 44 }, origin)
  expect(syncJsonSettings.mock.calls.at(-1)?.[2].previous).toEqual(fields)
})

it('shows incompatible platform setups only while the catalog origin and member delivery still exist', async () => {
  const delivery: PluginInstallation = { packageName: 'native', source: 'selected', version: '1.0.0', integrity: 'old', serviceOrigin: 'suite:catalog' }
  let records = [delivery]
  let origins = new Map([['native', 'suite:catalog']])
  const settings = new MemberNativeServiceSettings(
    { get: async () => records, replaceServiceSettings: async () => false },
    {
      installedServices: async () => ({
        revision: 'current',
        configuration: { identity: { id: 'catalog', version: '2.0.0' }, ownerVersion: 'new', slots: [slot], settings: [] },
      }),
    },
    {
      issue: vi.fn(),
      bindingAvailability: async () => undefined,
      installedServiceOrigins: async () => origins,
    },
    { syncSettings: vi.fn() },
  )

  await settings.ensureLaunch(actor, instance, origin)
  expect(await settings.list(actor, instance)).toEqual([{ packageName: 'native', bindings: [{ slot: '', status: 'unsupported' }] }])

  origins = new Map()
  expect(await settings.list(actor, instance)).toEqual([])
  const nextInstance = { ...instance, processId: 43 }
  await settings.ensureLaunch(actor, nextInstance, origin)
  expect(await settings.list(actor, nextInstance)).toEqual([])

  origins = new Map([['native', 'suite:another-catalog']])
  expect(await settings.list(actor, nextInstance)).toEqual([])
  origins = new Map([['native', 'suite:catalog']])
  records = [{ packageName: 'native', source: 'selected', version: '1.0.0', integrity: 'old' }]
  expect(await settings.list(actor, nextInstance)).toEqual([])
})
