import { expect, it } from 'vitest'
import { PluginUpstreamAccess } from '../src/use-cases/plugin-upstream-access.js'
import type { LibraryPlugin } from '../src/domain/plugin-library.js'
const account = { username: 'member', spaceId: 's', sessionEpoch: 0, admin: false, disabled: false, groupId: 'g', email: '', createdAt: 0, updatedAt: 0 }
function fixture() {
  const state = { template: 'Bearer {credential}', account: { ...account }, granted: true, published: false, incompatible: false, credential: 'platform-fictional', runtimeRevision: 'revision' }
  const access = new PluginUpstreamAccess({ get: () => state.account, listGroups: () => [{ id: 'g', kind: 'ordinary', name: 'g', isDefault: true, memberCount: 1 }] },
    { resolve: token => token === 'member-token' ? { username: 'member', spaceId: 's' } : undefined },
    { list: () => [{ packageName: '@sample/plugin', stage: 'available', current: { runtimeRevision: state.runtimeRevision }, published: state.published, incompatible: state.incompatible } as LibraryPlugin] },
    { get: () => state.granted ? ['@sample/plugin'] : [] },
    { list: () => [{ name: 'search', baseUrl: 'http://localhost/api', credential: state.credential, headers: [{ name: 'Authorization', value: state.template }, { name: 'X-Goog-Api-Key', value: '{credential}' }, { name: 'X-Tenant-ID', value: '42' }] }] }, 'revision')
  return { state, access, call: (headers = { authorization: 'Bearer member-token' } as Record<string, string>) => access.authorize('@sample/plugin', 'search', headers) }
}
it('recognizes token headers and checks fresh grant, publication, compatibility and credential on every call', () => {
  const f = fixture()
  expect(f.call().username).toBe('member')
  expect(f.call({ 'x-goog-api-key': 'member-token' }).username).toBe('member')
  f.state.granted = false; expect(() => f.call()).toThrow(/not authorized/u)
  f.state.published = true; expect(f.call().username).toBe('member')
  f.state.incompatible = true; expect(() => f.call()).toThrow(/unavailable/u)
  f.state.incompatible = false; f.state.credential = ''; expect(() => f.call()).toThrow(/not configured/u)
})
it('rejects absent, invalid, ambiguous and retired-space tokens and disabled accounts', () => {
  const f = fixture()
  for (const headers of [{}, { authorization: 'Bearer invalid' }, { authorization: 'Bearer member-token', 'x-api-key': 'other-token' }]) expect(() => f.call(headers)).toThrow(/token/u)
  expect(f.call({ authorization: 'Bearer member-token', 'x-api-key': 'member-token', 'x-tenant-id': 'forged' }).username).toBe('member')
  f.state.account.disabled = true; expect(() => f.call()).toThrow(/disabled/u)
  f.state.account.disabled = false; f.state.account.spaceId = 'new'; expect(() => f.call()).toThrow(/token/u)
})

it('recognizes a custom Authorization template as well as conventional Bearer', () => {
  const f = fixture(); f.state.template = 'ApiKey {credential}'
  expect(f.call({ authorization: 'ApiKey member-token' }).username).toBe('member')
  expect(f.call({ authorization: 'Bearer member-token' }).username).toBe('member')
})
