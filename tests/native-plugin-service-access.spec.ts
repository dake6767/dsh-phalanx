import { createServer, request as httpRequest, type Server } from 'node:http'
import { once } from 'node:events'
import { createConnection } from 'node:net'
import { MemorySessionRegistry } from '../src/adapters/memory-session-registry.js'
import { afterEach, expect, it, vi } from 'vitest'
import { NativePluginServiceAccess } from '../src/use-cases/native-plugin-service-access.js'
import { createNativePluginServiceGateway, NATIVE_SERVICE_BODY_LIMIT, NATIVE_SERVICE_TIMEOUT_MS } from '../src/inbound/native-plugin-service-gateway.js'
import { NodePluginUpstreamTransport } from '../src/adapters/plugin-upstream-transport.js'
import type { CatalogPluginServiceSlot } from '../src/domain/suite-service-slots.js'
import type { CommunityUserInstance } from '../src/ports/community-runtime.js'
import type { LibraryPlugin } from '../src/domain/plugin-library.js'
import { accountState } from './support/account-state.js'

const servers: Server[] = []
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})
async function listen(server: Server) {
  servers.push(server)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw Error('Missing address')
  return `http://127.0.0.1:${address.port}`
}

const backend = (id: string, protocol: CatalogPluginServiceSlot['backends'][number]['protocol']) =>
  ({
    id,
    protocol,
    mode: id,
    label: { en: id, 'zh-CN': id },
    upstream: { endpoint: 'ENDPOINT', key: 'KEY', model: 'MODEL' },
    fields: [
      { name: 'ENDPOINT', type: 'url', required: true, label: { en: 'Endpoint', 'zh-CN': 'Endpoint' } },
      { name: 'KEY', type: 'secret', required: true, label: { en: 'Key', 'zh-CN': 'Key' } },
      { name: 'MODEL', type: 'text', required: true, label: { en: 'Model', 'zh-CN': 'Model' } },
    ],
  }) as const

it('uses a member and backend scoped bearer and applies changes only to new requests', async () => {
  const requests: unknown[] = []
  let received!: () => void
  const started = new Promise<void>(resolve => {
    received = resolve
  })
  let release!: () => void
  const proceed = new Promise<void>(resolve => {
    release = resolve
  })
  let fastCompleted: (() => void) | undefined
  let pipelineHeld!: () => void
  const held = new Promise<void>(resolve => {
    pipelineHeld = resolve
  })
  let pipelineClosed!: () => void
  const upstreamClosed = new Promise<void>(resolve => {
    pipelineClosed = resolve
  })
  let timeoutStarted!: () => void
  const timeoutUpstreamStarted = new Promise<void>(resolve => {
    timeoutStarted = resolve
  })
  let timedOut!: () => void
  const timedOutUpstream = new Promise<void>(resolve => {
    timedOut = resolve
  })
  const upstream = await listen(
    createServer(async (request, response) => {
      const chunks = []
      for await (const chunk of request) chunks.push(chunk)
      const body = JSON.parse(Buffer.concat(chunks).toString())
      requests.push({ path: request.url, key: request.headers.authorization, body, cookie: request.headers.cookie })
      if (body.prompt === 'hold') {
        received()
        await proceed
      }
      if (body.prompt === 'timeout') {
        response.once('close', timedOut)
        timeoutStarted()
        return
      }
      if (body.prompt === 'hold-pipeline') {
        response.once('close', pipelineClosed)
        pipelineHeld()
        return
      }
      response.setHeader('content-type', 'application/json')
      if (body.prompt === 'redirect') response.writeHead(307, { location: 'https://example.test/elsewhere' })
      if (body.prompt === 'error') response.writeHead(429)
      const payload = ['error', 'echo'].includes(body.prompt) ? { error: request.headers.authorization } : { data: [{ b64_json: 'AAE=' }] }
      const result = body.prompt === 'encoded' ? { data: [{ url: 'https://example.test/image?key=cleared%2band-reconfigured-key' }] } : payload
      response.end(JSON.stringify(result))
    }),
  )
  const packageName = '@catalog/native-fixture',
    integrity = 'verified-fixture-integrity'
  const member = {
    username: 'member',
    spaceId: 'member-space',
    sessionEpoch: 2,
    groupId: 'g',
    disabled: false,
    admin: false,
    email: '',
    createdAt: 0,
    updatedAt: 0,
  }
  let instance: CommunityUserInstance = {
    userId: member.username,
    spaceId: member.spaceId,
    resourceKey: 'instance',
    origin: 'http://127.0.0.1:4190',
    launchUrl: '/',
    processId: 18,
  }
  const plugin: LibraryPlugin = {
    packageName,
    version: '1.0.0',
    stage: 'available',
    source: { kind: 'npm' },
    suiteOrigin: 'suite',
    published: true,
    current: {
      packageName,
      version: '1.0.0',
      integrity,
      artifact: 'fixture',
      runtimeRevision: 'runtime',
      title: 'Fixture',
      description: '',
      bundlePatch: '',
      dependencies: {},
    },
  }
  const slots: CatalogPluginServiceSlot[] = [
    {
      id: 'image',
      label: { en: 'Image', 'zh-CN': 'Image' },
      backends: [backend('seedream', 'seedream-image'), backend('openai', 'openai-image')],
      binding: {
        kind: 'revisioned-rpc',
        service: 'testSettings',
        active: ['active'],
        selection: ['selection'],
        profiles: ['profiles'],
        idKey: 'id',
        snapshotKey: 'snapshot',
        fields: { endpoint: 'url', key: 'key', model: 'model', mode: 'mode' },
      },
    },
  ]
  let preinstalled = true,
    selected = true,
    enabled = true,
    actualEnabled = true,
    serviceOrigin: string | undefined = 'suite',
    version = '1.0.0',
    key = 'fixture-provider-key',
    revision = 1
  let gateway = ''
  const access = new NativePluginServiceAccess({
    accounts: {
      ...accountState(username => (username === member.username ? member : undefined)),
      get: async username => (username === member.username ? member : undefined),
    },
    library: { list: async () => [plugin] },
    grants: { preinstalls: async () => (preinstalled ? [packageName] : []) },
    installations: {
      get: async () => [
        { packageName, source: selected ? 'selected' : 'preinstall', version: '1.0.0', integrity, ...(serviceOrigin ? { serviceOrigin } : {}) },
      ],
    },
    services: {
      installedServiceOwner: async () => integrity,
      installedServices: async () => ({
        revision: String(revision),
        configuration: {
          identity: { id: 'fixture-suite', version },
          ownerVersion: integrity,
          slots,
          settings: [{ slot: 'image', backend: 'seedream', enabled, values: { ENDPOINT: upstream + '/v3', KEY: key, MODEL: 'seedream-fixture' } }],
        },
      }),
    },
    runtime: { status: () => ({ state: 'ready', instance }) },
    manager: { list: async () => [{ packageName, version: '1.0.0', enabled: actualEnabled, archiveIntegrity: integrity }], verifyArchive: async () => true },
    origin: () => new URL('http://127.0.0.1:4180'),
    gatewayOrigin: () => new URL(gateway),
    signingKey: { read: () => 'fixture-signing-key' },
    revision: () => String(revision),
    runtimeRevision: 'runtime',
  })
  const registry = new MemorySessionRegistry()
  const handle = createNativePluginServiceGateway({
    access,
    transport: new NodePluginUpstreamTransport(),
    connections: {
      track: registry.track.bind(registry),
      untrack: connection => {
        registry.untrack(connection)
        fastCompleted?.()
      },
    },
  })
  gateway = await listen(
    createServer((request, response) => {
      void handle(request, response)
    }),
  )
  const grant = await access.issue(member, instance, packageName, 'image', 'seedream', AbortSignal.timeout(5000))
  const body = { model: 'seedream-fixture', image: ['data:image/png;base64,AAE='] }
  const call = (url: string, prompt = 'generate', token = grant.token) =>
    fetch(url + '/images/generations', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json', cookie: 'private=1' },
      body: JSON.stringify({ ...body, prompt }),
    })
  expect(grant.token).not.toContain(key)
  expect((await call(grant.url.replace('/seedream', '/openai'))).status).toBe(401)
  expect((await call(grant.url.replace('/member/', '/another/'))).status).toBe(401)
  expect((await call(grant.url, 'generate', 'general-member-token')).status).toBe(401)
  expect((await call(grant.url)).status).toBe(200)
  expect(requests).toEqual([{ path: '/v3/images/generations', key: 'Bearer fixture-provider-key', body: { ...body, prompt: 'generate' }, cookie: undefined }])
  preinstalled = false
  key = 'rotated-$&-provider-key'
  revision++
  const pending = call(grant.url, 'hold')
  await Promise.race([
    started,
    pending.then(response => {
      throw Error('Held request completed early with HTTP ' + response.status)
    }),
  ])
  selected = false
  revision++
  expect((await call(grant.url)).status).toBe(403)
  release()
  expect((await pending).status).toBe(200)
  expect(requests[1]).toMatchObject({ key: 'Bearer rotated-$&-provider-key' })
  preinstalled = true
  revision++
  expect((await call(grant.url)).status).toBe(200)
  enabled = false
  revision++
  expect((await call(grant.url)).status).toBe(503)
  expect(requests).toHaveLength(3)
  enabled = true
  key = ''
  revision++
  expect((await call(grant.url)).status).toBe(503)
  key = 'cleared+and-reconfigured-key'
  actualEnabled = false
  revision++
  expect((await call(grant.url)).status).toBe(403)
  actualEnabled = true
  serviceOrigin = undefined
  expect((await call(grant.url)).status).toBe(403)
  serviceOrigin = 'suite'
  expect((await fetch(grant.url + '/images/generations')).status).toBe(405)
  for (const [prompt, status] of [
    ['error', 429],
    ['echo', 502],
    ['encoded', 502],
    ['redirect', 502],
  ] as const) {
    const response = await call(grant.url, prompt)
    expect(response.status).toBe(status)
    expect(await response.text()).not.toContain(key)
    expect(response.headers.has('location')).toBe(false)
  }
  const endpoint = new URL(grant.url)
  const socket = createConnection({ host: endpoint.hostname, port: Number(endpoint.port) })
  try {
    await once(socket, 'connect')
    const closed = once(socket, 'close')
    const request = (prompt: string) => {
      const payload = JSON.stringify({ ...body, prompt })
      return `POST ${endpoint.pathname}/images/generations HTTP/1.1\r\nHost: ${endpoint.host}\r\nAuthorization: Bearer ${grant.token}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(payload)}\r\n\r\n${payload}`
    }
    socket.resume()
    socket.write(request('hold-pipeline'))
    await held
    const fast = new Promise<void>(resolve => {
      fastCompleted = resolve
    })
    socket.write(request('fast-pipeline'))
    await fast
    expect(registry.hasUser(member.username)).toBe(true)
    await registry.closeUser(member.username)
    await closed
    await upstreamClosed
  } finally {
    socket.destroy()
  }
  const oversized = await new Promise<number | undefined>((resolve, reject) => {
    const request = httpRequest(
      grant.url + '/images/generations',
      {
        method: 'POST',
        headers: { authorization: 'Bearer ' + grant.token, 'content-type': 'application/json', 'content-length': NATIVE_SERVICE_BODY_LIMIT + 1 },
      },
      response => {
        response.resume()
        resolve(response.statusCode)
      },
    )
    request.once('error', reject)
    request.end()
  })
  expect(oversized).toBe(413)
  expect(requests).toHaveLength(9)
  expect(NATIVE_SERVICE_TIMEOUT_MS).toBe(180_000)
  const timeout = AbortSignal.timeout.bind(AbortSignal)
  const deadline = new AbortController()
  const clock = vi.spyOn(AbortSignal, 'timeout').mockImplementation(ms => (ms === NATIVE_SERVICE_TIMEOUT_MS ? deadline.signal : timeout(ms)))
  try {
    const pending = call(grant.url, 'timeout')
    await Promise.race([
      timeoutUpstreamStarted,
      pending.then(response => {
        throw Error('Expected the upstream to hang, got HTTP ' + response.status)
      }),
    ])
    deadline.abort(new DOMException('The test deadline elapsed', 'TimeoutError'))
    expect((await pending).status).toBe(504)
    await timedOutUpstream
  } finally {
    deadline.abort()
    clock.mockRestore()
  }
  version = '1.1.0'
  revision++
  expect((await call(grant.url)).status).toBe(403)
  instance = { ...instance, resourceKey: 'replacement' }
  expect((await call(grant.url)).status).toBe(401)
  expect(requests).toHaveLength(10)
})
