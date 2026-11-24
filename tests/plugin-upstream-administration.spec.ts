import { expect, it, vi } from 'vitest'
import { PluginUpstreamAdministration } from '../src/use-cases/plugin-upstream-administration.js'
import type { PluginUpstream } from '../src/domain/plugin-upstream.js'
import type { LibraryPlugin } from '../src/domain/plugin-library.js'
import { suiteInstallOrigin } from '../src/domain/suite-install.js'
import type { CatalogPluginServiceSlot } from '../src/domain/suite-service-slots.js'

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

it('exposes a pending signed upstream, preconfigures its request and reuses a matching stored configuration', async () => {
  const names = { en: 'Image provider', 'zh-CN': '生图服务' }
  const slot = {
    id: 'image',
    label: names,
    binding: {
      kind: 'json-settings',
      deferredUpstream: true,
      file: 'image-upstream.json',
      upstream: 'images',
      fields: [
        { path: ['endpoint'], source: 'gateway-url' },
        { path: ['model'], source: 'model' },
        { path: ['token'], source: 'service-token' },
      ],
    },
    backends: [
      {
        id: 'openai',
        label: names,
        protocol: 'openai-image',
        mode: 'openai',
        fields: [{ name: 'model', required: true, type: 'text' }],
        upstream: { model: 'model' },
      },
    ],
  } as const satisfies CatalogPluginServiceSlot
  const plugin = { packageName: 'plugin', revision: 7, suiteOrigin: suiteInstallOrigin('images'), current: { integrity: 'archive-integrity' } } as LibraryPlugin
  let revision = 'none'
  const write = vi.fn(async (_packageName: string, values: readonly PluginUpstream[]) => {
    rows = values
    revision += '-saved'
  })
  const refresh = vi.fn(async () => undefined)
  let rows: readonly PluginUpstream[] = []
  let definition: readonly CatalogPluginServiceSlot[] = [slot]
  const administration = new PluginUpstreamAdministration(
    { get: async () => admin },
    { list: async () => [plugin] },
    { list: () => rows, revision: () => revision, snapshot: () => ({ upstreams: rows, revision }), save: write },
    undefined,
    {
      installedServices: async () => ({
        revision: 'revision',
        configuration: { identity: { id: 'images', version: '1.0.0' }, ownerVersion: plugin.current!.integrity, slots: definition, settings: [] },
      }),
    },
    refresh,
  )
  const opened = (await administration.list(admin, 'plugin'))[0]!
  expect(opened).toMatchObject({
    name: 'images',
    managedImage: { ready: false, revision: { upstream: 'none', plugin: 7 } },
    credential: { configured: false },
  })
  expect(write).not.toHaveBeenCalled()
  const baseUrl = 'https://images.example.test/v1'
  const credential = 'image-fixture-key'
  const saved = await administration.execute(admin, 'plugin', {
    action: 'save',
    expectedRevision: opened.managedImage!.revision!,
    upstream: { name: 'images', model: 'fixture-model', baseUrl, credential, headers: [{ name: 'x-ignored', value: 'ignored' }] },
  })
  expect(saved).toMatchObject([{ name: 'images', model: 'fixture-model', managedImage: { ready: true } }])
  expect(JSON.stringify(saved)).not.toContain(credential)
  expect(saved[0]?.credential).toEqual({ configured: true, last4: '' })
  await expect(
    administration.execute(admin, 'plugin', {
      action: 'save',
      upstream: { name: 'images', model: 'old-page-model', baseUrl, credential: 'old-page-key', headers: [] },
    }),
  ).rejects.toMatchObject({ code: 'platform-configuration-conflict' })
  await expect(
    administration.execute(admin, 'plugin', {
      action: 'save',
      expectedRevision: saved[0]!.managedImage!.revision!,
      upstream: { name: 'images', model: 'fixture-model', baseUrl, credential: 'key with whitespace', headers: [] },
    }),
  ).rejects.toMatchObject({ code: 'plugin-upstream-invalid' })
  await expect(
    administration.execute(admin, 'plugin', {
      action: 'save',
      expectedRevision: opened.managedImage!.revision!,
      upstream: { name: 'images', model: 'stale-model', baseUrl, credential: 'stale-key', headers: [] },
    }),
  ).rejects.toMatchObject({ code: 'platform-configuration-conflict' })
  expect(rows).toEqual([
    {
      name: 'images',
      baseUrl,
      credential,
      model: 'fixture-model',
      nativeServiceOnly: true,
      headers: [{ name: 'Authorization', value: 'Bearer {credential}' }],
      testRequest: { method: 'GET', path: '/models' },
    },
  ])
  expect(refresh).toHaveBeenCalledWith('plugin')
  await expect(administration.execute(admin, 'plugin', { action: 'delete', name: 'images' })).rejects.toThrow(/referenced/u)
  definition = []
  expect((await administration.list(admin, 'plugin'))[0]?.managedImage).toBeUndefined()
  await administration.execute(admin, 'plugin', {
    action: 'save',
    upstream: { name: 'images', baseUrl, headers: rows[0]!.headers },
  })
  expect(rows[0]?.nativeServiceOnly).toBe(true)
  definition = [slot]
  expect((await administration.list(admin, 'plugin'))[0]?.managedImage?.ready).toBe(true)
  expect(write).toHaveBeenCalledTimes(2)
  const current = (await administration.list(admin, 'plugin'))[0]!
  const disabled = (
    await administration.execute(admin, 'plugin', {
      action: 'save',
      expectedRevision: current.managedImage!.revision!,
      enabled: false,
      upstream: { name: 'images', baseUrl, headers: [] },
    })
  )[0]!
  expect(disabled).toMatchObject({ credential: { configured: true }, managedImage: { disabled: true, ready: false } })
  const updated = (
    await administration.execute(admin, 'plugin', {
      action: 'save',
      expectedRevision: disabled.managedImage!.revision!,
      upstream: { name: 'images', baseUrl, model: 'updated-model', headers: [] },
    })
  )[0]!
  expect(updated).toMatchObject({ model: 'updated-model', managedImage: { disabled: true, ready: false } })
  const enabled = (
    await administration.execute(admin, 'plugin', {
      action: 'save',
      expectedRevision: updated.managedImage!.revision!,
      enabled: true,
      upstream: { name: 'images', baseUrl, headers: [] },
    })
  )[0]!
  expect(enabled).toMatchObject({ model: 'updated-model', credential: { configured: true }, managedImage: { ready: true } })
})
