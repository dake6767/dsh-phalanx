import { afterEach, expect, it } from 'vitest'
import { PluginPreparationError } from '../src/domain/plugin-library.js'
import { cleanupPluginHttpFixture, pluginHttpFixture as fixture, stopPluginHttpApplication } from './support/plugin-http.js'

afterEach(cleanupPluginHttpFixture)

it('keeps a resolved npm precheck outside the library until confirmation and adopts exactly its checked bytes', async () => {
  const { requests, preparations, integrity, request, get, setLatest } = await fixture()
  const previewResponse = await request('plugins/previews', { input: '@fixture/reports@latest' })
  expect(previewResponse.status).toBe(202)
  const started = await previewResponse.json()
  await expect.poll(async () => (await get('plugins/previews?token=' + started.token)).stage).toBe('ready')
  const preview = await get('plugins/previews?token=' + started.token)
  expect(preview).toMatchObject({ token: started.token, source: 'npm', packageName: '@fixture/reports', version: '1.0.0', integrity, stage: 'ready' })
  expect(JSON.stringify(preview)).not.toContain('/private/')
  expect(preparations).toEqual([{ packageName: '@fixture/reports', version: '1.0.0' }])
  expect(requests).toHaveLength(1)
  expect(decodeURIComponent(requests[0]!)).toBe('/registry/@fixture/reports')
  expect(await get('plugins')).toEqual([])
  expect((await get('groups/default/plugins')).plugins).toEqual([])
  setLatest('2.0.0')
  const confirmed = await request('plugins/previews/confirm', { token: started.token })
  expect(confirmed.status).toBe(200)
  expect(await confirmed.json()).toMatchObject({
    packageName: '@fixture/reports',
    version: '1.0.0',
    currentVersion: '1.0.0',
    integrity,
    published: false,
    stage: 'available',
  })
  expect(requests).toHaveLength(1)
  expect(preparations).toHaveLength(1)
  expect((await get('groups/default/plugins')).plugins).toMatchObject([{ packageName: '@fixture/reports', granted: false, preinstalled: false }])
  const duplicate = await request('plugins/previews', { input: '@fixture/reports@latest' })
  expect(duplicate.status).toBe(409)
  expect(await duplicate.json()).toMatchObject({ code: 'plugin-name-in-use' })
  expect(requests).toHaveLength(1)
  expect(preparations).toHaveLength(1)
})

it('accepts only the supported npm input forms and explains each rejected source, tag and range', async () => {
  const { request, get, requests } = await fixture()
  for (const [input, packageName, version] of [
    ['plain-plugin', 'plain-plugin', '1.0.0'],
    ['plain-plugin@latest', 'plain-plugin', '1.0.0'],
    ['plain-plugin@2.0.0', 'plain-plugin', '2.0.0'],
    [' @scope/tools ', '@scope/tools', '1.0.0'],
    ['@scope/tools@2.0.0', '@scope/tools', '2.0.0'],
  ]) {
    const response = await request('plugins/previews', { input })
    expect(response.status).toBe(202)
    const started = await response.json()
    await expect.poll(async () => (await get('plugins/previews?token=' + started.token)).stage).toBe('ready')
    expect(await get('plugins/previews?token=' + started.token)).toMatchObject({ packageName, version, source: 'npm' })
  }
  expect(requests).toHaveLength(3)
  for (const [input, code] of [
    ['plain-plugin@^1.2.0', 'plugin-version-range-unsupported'],
    ['plain-plugin@1.2', 'plugin-version-range-unsupported'],
    ['plain-plugin@next', 'plugin-tag-unsupported'],
    ['git+https://github.com/example/plugin.git', 'plugin-git-url-unsupported'],
    ['git@github.com:example/plugin.git', 'plugin-git-url-unsupported'],
    ['https://gitlab.example.test/example/plugin', 'plugin-source-host-unsupported'],
    ['', 'plugin-input-invalid'],
    ['plain-plugin@', 'plugin-input-invalid'],
  ]) {
    const response = await request('plugins/previews', { input })
    expect(response.status).toBe(400)
    const body = await response.json()
    expect(body).toMatchObject({ code })
    if (code === 'plugin-source-host-unsupported') expect(body.error).toBe('Only npm packages and github.com repositories are supported.')
  }
  expect(requests).toHaveLength(3)
  expect(await get('plugins')).toEqual([])
  expect((await request('plugins/previews', { input: 'plain-plugin', version: '1.0.0' })).status).toBe(400)
})

it('retries the original resolved identity and cancels unconfirmed work without publishing library facts', async () => {
  let fail = true,
    hold = false,
    aborted = false
  let entered!: () => void
  const started = new Promise<void>(resolve => {
    entered = resolve
  })
  const { request, get, requests, preparations, setLatest } = await fixture({
    beforePrepare: async (_input, signal) => {
      if (fail) {
        fail = false
        throw new PluginPreparationError('plugin-precheck-failed')
      }
      if (hold) {
        entered()
        await new Promise<void>((_resolve, reject) => {
          const abort = () => {
            aborted = true
            reject(new PluginPreparationError('plugin-job-interrupted'))
          }
          if (signal.aborted) abort()
          else signal.addEventListener('abort', abort, { once: true })
        })
      }
    },
  })
  const first = await (await request('plugins/previews', { input: 'retry-plugin@latest' })).json()
  await expect.poll(async () => (await get('plugins/previews?token=' + first.token)).stage).toBe('failed')
  expect(await get('plugins')).toEqual([])
  setLatest('2.0.0')
  expect((await request('plugins/previews/retry', { token: first.token })).status).toBe(202)
  await expect.poll(async () => (await get('plugins/previews?token=' + first.token)).stage).toBe('ready')
  expect(await get('plugins/previews?token=' + first.token)).toMatchObject({ version: '1.0.0' })
  expect(requests).toHaveLength(1)
  expect(preparations.map(row => row.version)).toEqual(['1.0.0', '1.0.0'])
  expect((await request('plugins/previews/cancel', { token: first.token })).status).toBe(200)
  expect((await request('plugins/previews/confirm', { token: first.token })).status).toBe(404)
  hold = true
  const pending = await (await request('plugins/previews', { input: 'pending-plugin' })).json()
  await started
  expect((await request('plugins/previews/cancel', { token: pending.token })).status).toBe(200)
  expect(aborted).toBe(true)
  expect((await request('plugins/previews?token=' + pending.token)).status).toBe(404)
  expect(await get('plugins')).toEqual([])
})

it('rejects the old automatic npm add and retries a failed uploaded archive from its original bytes', async () => {
  let fail = true
  const { request, get, preparations, requests, origin, cookie } = await fixture({
    beforePrepare: async () => {
      if (fail) {
        fail = false
        throw new PluginPreparationError('plugin-precheck-failed')
      }
    },
  })
  expect((await request('plugins', { action: 'add', packageName: 'bypass-plugin', version: '1.0.0' })).status).toBe(400)
  expect((await request('plugins', { action: 'retry', input: 'bypass-plugin@1.0.0' })).status).toBe(404)
  expect(await get('plugins')).toEqual([])
  const uploaded = await fetch(origin + '/admin/api/plugins/upload', {
    method: 'POST',
    headers: { cookie, origin, 'content-type': 'application/gzip', 'x-plugin-filename': 'fixture.tgz' },
    body: Buffer.from('uploaded-archive-fixture'),
  })
  expect(uploaded.status).toBe(202)
  await expect.poll(async () => (await get('plugins'))[0]?.stage).toBe('failed')
  expect((await request('plugins', { action: 'retry', input: 'uploaded-plugin@1.0.0' })).status).toBe(202)
  await expect.poll(async () => (await get('plugins'))[0]?.stage).toBe('available')
  expect((await get('plugins'))[0]).toMatchObject({ source: 'upload', currentVersion: '1.0.0', published: false })
  expect(requests).toEqual([])
  expect(preparations).toHaveLength(2)
  expect(preparations[0]?.upload).toBeDefined()
  expect(preparations[1]?.upload).toEqual(preparations[0]?.upload)
})

it('prechecks an exact identity through the existing preparer without depending on tag metadata', async () => {
  const { request, get, requests, preparations } = await fixture({ metadataUnavailable: true })
  const response = await request('plugins/previews', { input: 'precise-plugin@2.0.0' })
  expect(response.status).toBe(202)
  const preview = await response.json()
  await expect.poll(async () => (await get('plugins/previews?token=' + preview.token)).stage).toBe('ready')
  expect(preparations).toEqual([{ packageName: 'precise-plugin', version: '2.0.0' }])
  expect(requests).toEqual([])
  expect((await request('plugins/previews/confirm', { token: preview.token })).status).toBe(200)
})

it('binds previews to the administrator and rechecks current permission and origin at confirmation', async () => {
  const { request, get, origin, cookie } = await fixture()
  expect((await request('accounts', { username: 'other', email: 'other@example.test', password: 'password' })).status).toBe(201)
  expect((await request('accounts/other/actions', { action: 'set-admin', admin: true })).status).toBe(200)
  const login = await fetch(origin + '/login', {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: 'other', password: 'password' }),
  })
  expect(login.status).toBe(303)
  const otherCookie = login.headers
    .getSetCookie()
    .map(value => value.split(';')[0])
    .join('; ')
  const otherRequest = (path: string, body?: unknown) =>
    fetch(origin + '/admin/api/' + path, {
      headers: { cookie: otherCookie, origin, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
    })
  const preview = await (await request('plugins/previews', { input: 'private-preview' })).json()
  await expect.poll(async () => (await get('plugins/previews?token=' + preview.token)).stage).toBe('ready')
  expect((await otherRequest('plugins/previews?token=' + preview.token)).status).toBe(404)
  for (const action of ['confirm', 'retry', 'cancel']) expect((await otherRequest('plugins/previews/' + action, { token: preview.token })).status).toBe(404)
  const crossOrigin = await fetch(origin + '/admin/api/plugins/previews/confirm', {
    method: 'POST',
    headers: { cookie, origin: 'https://other.example.test', 'content-type': 'application/json' },
    body: JSON.stringify({ token: preview.token }),
  })
  expect(crossOrigin.status).toBe(403)
  expect((await otherRequest('accounts/admin/actions', { action: 'set-admin', admin: false, groupId: 'default' })).status).toBe(200)
  expect((await request('plugins/previews/confirm', { token: preview.token })).status).toBe(403)
  expect(await (await otherRequest('plugins')).json()).toEqual([])
})

it('expires unconfirmed previews and aborts active preparations when the application stops', async () => {
  let now = Date.now(),
    aborted = false,
    entered!: () => void
  const pending = new Promise<void>(resolve => {
    entered = resolve
  })
  const { request, get } = await fixture({
    clock: { now: () => now },
    beforePrepare: async (input, signal) => {
      if (input.packageName !== 'pending-shutdown') return
      entered()
      await new Promise<void>((_resolve, reject) => {
        const abort = () => {
          aborted = true
          reject(new PluginPreparationError('plugin-job-interrupted'))
        }
        if (signal.aborted) abort()
        else signal.addEventListener('abort', abort, { once: true })
      })
    },
  })
  const preview = await (await request('plugins/previews', { input: 'expired-plugin' })).json()
  await expect.poll(async () => (await get('plugins/previews?token=' + preview.token)).stage).toBe('ready')
  now += 30 * 60 * 1000
  for (const action of ['confirm', 'retry', 'cancel']) {
    const response = await request('plugins/previews/' + action, { token: preview.token })
    expect(response.status).toBe(404)
    expect(await response.json()).toMatchObject({ code: 'plugin-preview-unavailable' })
  }
  expect(await get('plugins')).toEqual([])
  expect((await request('plugins/previews', { input: 'pending-shutdown' })).status).toBe(202)
  await pending
  await stopPluginHttpApplication()
  expect(aborted).toBe(true)
})

it('serializes competing confirmations and rejects changed bytes for the same package version', async () => {
  const { request, get, setIntegrity, integrity } = await fixture()
  const start = async (input: string) => {
    const response = await request('plugins/previews', { input })
    expect(response.status).toBe(202)
    const preview = await response.json()
    await expect.poll(async () => (await get('plugins/previews?token=' + preview.token)).stage).toBe('ready')
    return preview.token as string
  }
  const original = await start('conflict-plugin@1.0.0')
  setIntegrity('sha512-' + Buffer.alloc(64, 8).toString('base64'))
  const changed = await start('conflict-plugin@1.0.0')
  const responses = await Promise.all([request('plugins/previews/confirm', { token: original }), request('plugins/previews/confirm', { token: original })])
  expect(responses.map(response => response.status).sort()).toEqual([200, 404])
  const rejected = await request('plugins/previews/confirm', { token: changed })
  expect(rejected.status).toBe(503)
  expect(await rejected.json()).toMatchObject({ code: 'plugin-version-conflict' })
  expect(await get('plugins')).toMatchObject([{ packageName: 'conflict-plugin', currentVersion: '1.0.0', integrity }])
})

it('reports registry resolution failures and retries resolution only after an unresolved precheck', async () => {
  const { request, get, requests, preparations, setMetadata, setMetadataUnavailable } = await fixture({ metadataUnavailable: true })
  const preview = await (await request('plugins/previews', { input: 'resolution-plugin' })).json()
  const state = () => get('plugins/previews?token=' + preview.token)
  await expect.poll(async () => (await state()).stage).toBe('failed')
  expect(await state()).toMatchObject({ failureCode: 'plugin-registry-unavailable' })
  expect(preparations).toEqual([])
  setMetadataUnavailable(false)
  setMetadata(null)
  expect((await request('plugins/previews/retry', { token: preview.token })).status).toBe(202)
  await expect.poll(async () => (await state()).stage).toBe('failed')
  expect(await state()).toMatchObject({ failureCode: 'plugin-registry-metadata-invalid' })
  expect(preparations).toEqual([])
  setMetadata(undefined)
  expect((await request('plugins/previews/retry', { token: preview.token })).status).toBe(202)
  await expect.poll(async () => (await state()).stage).toBe('ready')
  expect(requests).toHaveLength(3)
  expect(preparations).toEqual([{ packageName: 'resolution-plugin', version: '1.0.0' }])
  expect(await get('plugins')).toEqual([])
})

it('reports retained precheck cleanup failures at shutdown while still draining existing library preparations', async () => {
  let uploadAborted = false,
    entered!: () => void
  const pendingUpload = new Promise<void>(resolve => {
    entered = resolve
  })
  const { request, get, origin, cookie } = await fixture({
    beforePrepare: async (input, signal) => {
      if (input.packageName === 'unclean-plugin') throw new PluginPreparationError('plugin-cleanup-failed')
      entered()
      await new Promise<void>((_resolve, reject) => {
        const abort = () => {
          uploadAborted = true
          reject(new PluginPreparationError('plugin-job-interrupted'))
        }
        if (signal.aborted) abort()
        else signal.addEventListener('abort', abort, { once: true })
      })
    },
  })
  expect(
    (
      await fetch(origin + '/admin/api/plugins/upload', {
        method: 'POST',
        headers: { cookie, origin, 'content-type': 'application/gzip', 'x-plugin-filename': 'fixture.tgz' },
        body: Buffer.from('pending-upload-fixture'),
      })
    ).status,
  ).toBe(202)
  await pendingUpload
  const preview = await (await request('plugins/previews', { input: 'unclean-plugin@1.0.0' })).json()
  const state = () => get('plugins/previews?token=' + preview.token)
  await expect.poll(async () => (await state()).stage).toBe('failed')
  expect(await state()).toMatchObject({ failureCode: 'plugin-cleanup-failed' })
  expect((await request('plugins/previews/cancel', { token: preview.token })).status).toBe(503)
  const stopped = stopPluginHttpApplication()
  await expect(stopped).rejects.toMatchObject({ errors: expect.arrayContaining([expect.objectContaining({ code: 'plugin-cleanup-failed' })]) })
  expect(uploadAborted).toBe(true)
})
