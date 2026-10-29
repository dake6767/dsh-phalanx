import { expect, it } from 'vitest'
import { PluginUpstreamAdministration } from '../src/use-cases/plugin-upstream-administration.js'
import type { PluginUpstream } from '../src/domain/plugin-upstream.js'
import type { LibraryPlugin } from '../src/domain/plugin-library.js'

const admin = { username: 'admin', spaceId: 'a', sessionEpoch: 0, admin: true, disabled: false, groupId: 'g', email: '', createdAt: 0, updatedAt: 0 }
function fixture() {
  let rows: readonly PluginUpstream[] = []
  let references: readonly string[] = []
  const useCase = new PluginUpstreamAdministration(
    { get: async () => admin },
    { list: async () => [{ packageName: 'plugin' } as LibraryPlugin] },
    {
      list: () => rows,
      save: async (_, next) => {
        rows = next
      },
    },
    { references: () => references },
  )
  const input = {
    name: 'search',
    baseUrl: 'http://127.0.0.1:9999/api',
    credential: 'fictional-key',
    headers: [
      { name: 'Authorization', value: 'Bearer {credential}' },
      { name: 'X-Tenant-ID', value: '42' },
    ],
  }
  return {
    useCase,
    input,
    rows: () => rows,
    reference: () => {
      references = ['env.SEARCH_URL']
    },
  }
}
it('returns only configured and last4 for credentials and locked headers, preserving blank writes', async () => {
  const f = fixture()
  const save = async (upstream: typeof f.input | Omit<typeof f.input, 'credential'>) => await f.useCase.execute(admin, 'plugin', { action: 'save', upstream })
  expect((await save(f.input))[0]).toEqual({
    name: 'search',
    baseUrl: f.input.baseUrl,
    headers: [
      { name: 'Authorization', configured: true, last4: 'ial}' },
      { name: 'X-Tenant-ID', configured: true, last4: '42' },
    ],
    credential: { configured: true, last4: '-key' },
  })
  const withoutKey = { name: f.input.name, baseUrl: f.input.baseUrl, headers: f.input.headers }
  await save({ ...withoutKey, baseUrl: 'https://example.invalid/v2' })
  expect(f.rows()[0]?.credential).toBe('fictional-key')
  await save({ ...f.input, credential: 'replacement' })
  expect(f.rows()[0]?.credential).toBe('replacement')
  const blank = { ...f.input, credential: '', headers: f.input.headers.map(row => ({ name: row.name, value: '' })) }
  await save(blank)
  expect(f.rows()[0]?.credential).toBe('replacement')
  expect(f.rows()[0]?.headers).toEqual(f.input.headers)
  const listed = JSON.stringify(await f.useCase.list(admin, 'plugin'))
  const contribution = JSON.stringify(await f.useCase.contributionList(admin, 'plugin'))
  for (const value of ['replacement', 'Bearer {credential}']) {
    expect(listed).not.toContain(value)
    expect(contribution).not.toContain(value)
  }
  expect(f.rows()).toHaveLength(1)
})
it('rejects referenced deletion and stale or non-admin identities', async () => {
  const f = fixture()
  await f.useCase.execute(admin, 'plugin', { action: 'save', upstream: f.input })
  f.reference()
  await expect(f.useCase.execute(admin, 'plugin', { action: 'delete', name: 'search' })).rejects.toThrow(/referenced/u)
  await expect(f.useCase.list({ ...admin, sessionEpoch: 1 }, 'plugin')).rejects.toThrow(/Sign in/u)
})
it.each([
  { name: '../escape' },
  { baseUrl: 'file:///etc/passwd' },
  { baseUrl: 'https://user:key@example.invalid/' },
  { headers: [{ name: 'Host', value: 'evil' }] },
  { headers: [{ name: 'X-Test', value: 'a\r\nb' }] },
  {
    headers: [
      { name: 'X-Key', value: '{credential}' },
      { name: 'x-key', value: 'duplicate' },
    ],
  },
])('rejects unsafe upstream configuration %j', async patch => {
  const f = fixture()
  await expect(f.useCase.execute(admin, 'plugin', { action: 'save', upstream: { ...f.input, ...patch } })).rejects.toThrow()
})

it('retains saved test requests across credential replacement and supports clearing them', async () => {
  const f = fixture()
  const testRequest = { method: 'POST', path: '/test?q=one', body: { query: 'sample' } }
  expect((await f.useCase.execute(admin, 'plugin', { action: 'save', upstream: { ...f.input, testRequest } }))[0]?.testRequest).toEqual({
    method: 'POST',
    configured: true,
  })
  expect((await f.useCase.execute(admin, 'plugin', { action: 'save', upstream: { ...f.input, credential: 'new' } }))[0]?.testRequest).toEqual({
    method: 'POST',
    configured: true,
  })
  expect((await f.useCase.execute(admin, 'plugin', { action: 'save', upstream: { ...f.input, testRequest: null } }))[0]?.testRequest).toBeUndefined()
  for (const path of ['//other.test/path', 'https://other.test/', '/bad path', '/path#fragment'])
    await expect(f.useCase.execute(admin, 'plugin', { action: 'save', upstream: { ...f.input, testRequest: { method: 'POST', path } } })).rejects.toThrow()
})
