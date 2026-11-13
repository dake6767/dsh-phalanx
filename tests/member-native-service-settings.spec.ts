import { expect, it, vi } from 'vitest'
import type { CatalogPluginServiceSlot } from '../src/domain/suite-service-slots.js'
import type { NativeServiceSettingsTransport } from '../src/ports/member-native-plugins.js'
import type { PluginInstallation } from '../src/ports/plugin-installations.js'
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
    { issue: async () => ({ token: 'member-scope', url: 'http://localhost/scoped', model: 'model', protocol: 'openai-chat' }) },
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
