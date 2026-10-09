import { expect, it } from 'vitest'
import { PluginUpstreamAdministration } from '../src/use-cases/plugin-upstream-administration.js'
import type { PluginUpstream } from '../src/domain/plugin-upstream.js'
import type { LibraryPlugin } from '../src/domain/plugin-library.js'

const admin = { username: 'admin', spaceId: 'a', sessionEpoch: 0, admin: true, disabled: false, groupId: 'g', email: '', createdAt: 0, updatedAt: 0 }
function fixture() {
  let rows: readonly PluginUpstream[] = []
  let references: readonly string[] = []
  const useCase = new PluginUpstreamAdministration({ get: () => admin }, { list: () => [{ packageName: 'plugin' } as LibraryPlugin] },
    { list: () => rows, save: (_, next) => { rows = next } }, { references: () => references })
  const input = { name: 'search', baseUrl: 'http://127.0.0.1:9999/api', credential: 'fictional-key', headers: [{ name: 'Authorization', value: 'Bearer {credential}' }, { name: 'X-Tenant-ID', value: '42' }] }
  return { useCase, input, rows: () => rows, reference: () => { references = ['env.SEARCH_URL'] } }
}
it('stores credentials without returning them and preserves, replaces and clears them explicitly', () => {
  const f = fixture()
  const save = (upstream: typeof f.input | Omit<typeof f.input, 'credential'>) => f.useCase.execute(admin, 'plugin', { action: 'save', upstream })
  expect(save(f.input)[0]).toEqual({ name: 'search', baseUrl: f.input.baseUrl, headers: f.input.headers, hasCredential: true })
  const withoutKey = { name: f.input.name, baseUrl: f.input.baseUrl, headers: f.input.headers }
  save({ ...withoutKey, baseUrl: 'https://example.invalid/v2' })
  expect(f.rows()[0]?.credential).toBe('fictional-key')
  save({ ...f.input, credential: 'replacement' }); expect(f.rows()[0]?.credential).toBe('replacement')
  expect(save({ ...f.input, credential: '' })[0]?.hasCredential).toBe(false)
  expect(f.rows()).toHaveLength(1)
})
it('rejects referenced deletion and stale or non-admin identities', () => {
  const f = fixture(); f.useCase.execute(admin, 'plugin', { action: 'save', upstream: f.input }); f.reference()
  expect(() => f.useCase.execute(admin, 'plugin', { action: 'delete', name: 'search' })).toThrow(/referenced/u)
  expect(() => f.useCase.list({ ...admin, sessionEpoch: 1 }, 'plugin')).toThrow(/Sign in/u)
})
it.each([
  { name: '../escape' }, { baseUrl: 'file:///etc/passwd' }, { baseUrl: 'https://user:key@example.invalid/' },
  { headers: [{ name: 'Host', value: 'evil' }] }, { headers: [{ name: 'X-Test', value: 'a\r\nb' }] },
  { headers: [{ name: 'X-Key', value: '{credential}' }, { name: 'x-key', value: 'duplicate' }] },
])('rejects unsafe upstream configuration %j', patch => {
  const f = fixture(); expect(() => f.useCase.execute(admin, 'plugin', { action: 'save', upstream: { ...f.input, ...patch } })).toThrow()
})

it('retains saved test requests across credential replacement and supports clearing them', () => {
  const f = fixture()
  const testRequest = { method: 'POST', path: '/test?q=one', body: { query: 'sample' } }
  expect(f.useCase.execute(admin, 'plugin', { action: 'save', upstream: { ...f.input, testRequest } })[0]?.testRequest).toEqual(testRequest)
  expect(f.useCase.execute(admin, 'plugin', { action: 'save', upstream: { ...f.input, credential: 'new' } })[0]?.testRequest).toEqual(testRequest)
  expect(f.useCase.execute(admin, 'plugin', { action: 'save', upstream: { ...f.input, testRequest: null } })[0]?.testRequest).toBeUndefined()
  for (const path of ['//other.test/path', 'https://other.test/', '/bad path', '/path#fragment']) expect(() => f.useCase.execute(admin, 'plugin', { action: 'save', upstream: { ...f.input, testRequest: { method: 'POST', path } } })).toThrow()
})
