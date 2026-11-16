import { expect, it } from 'vitest'
import { MemberPluginUpstreams } from '../src/use-cases/member-plugin-upstreams.js'
import type { CatalogPluginServiceSlot } from '../src/domain/suite-service-slots.js'

it('reserves only installed JSON service upstreams from the legacy member paths', async () => {
  const upstreams = ['service', 'legacy'].map(name => ({ name, baseUrl: 'https://provider.test', headers: [], credential: 'fixture-credential' }))
  const slot: CatalogPluginServiceSlot = {
    id: 'image',
    label: { en: 'Image', 'zh-CN': '生图' },
    binding: { kind: 'json-settings', file: 'media-desk/settings.json', upstream: 'service', fields: [] },
    backends: [],
  }
  let slots: readonly CatalogPluginServiceSlot[] = [slot]
  const member = new MemberPluginUpstreams(
    { list: async () => upstreams, authorizationRevision: name => 'upstreams:' + name },
    { installedServices: async () => ({ revision: 'rev', configuration: { identity: { id: 'suite', version: '1.0.0' }, slots, settings: [] } }) },
  )
  expect((await member.list('fixture')).map(row => row.name)).toEqual(['legacy'])
  expect(member.authorizationRevision('fixture')).toBe('upstreams:fixture')
  slots = []
  expect((await member.list('fixture')).map(row => row.name)).toEqual(['service', 'legacy'])
})
