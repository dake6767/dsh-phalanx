import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createServer, request as httpRequest, type Server } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { CommunityAccountStore } from '../src/adapters/community-account-store.js'
import { FileCommunityModelAccess } from '../src/adapters/community-model-access.js'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { createCommunityModelGateway } from '../src/inbound/community-model-gateway.js'
import { StaticCommunityModelUpstream } from '../src/adapters/community-model-upstream.js'
import { CommunityModelAuthorization } from '../src/use-cases/community-model-authorization.js'
import { MemorySessionRegistry } from '../src/adapters/memory-session-registry.js'

const listen = async (server: Server) => {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}
describe('community default model gateway HTTP seam', () => {
  const servers: Server[] = []
  const hostGateway = async (deps: Omit<Parameters<typeof createCommunityModelGateway>[0], 'connections'>) => {
    const connections = new MemorySessionRegistry()
    const handle = createCommunityModelGateway({ ...deps, connections })
    const server = createServer((request, response) => { void handle(request, response) })
    servers.push(server)
    server.on('connection', socket => connections.registerConnection(socket, true))
    return await listen(server)
  }
  afterEach(async () => { for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) } })
  it('brokers the default model using only the static upstream credential', async () => {
    const captured: { path?: string; key?: string; body?: unknown } = {}
    const upstream = createServer((request, response) => { void (async () => {
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk as Uint8Array))
      captured.path = request.url ?? '/'; captured.key = request.headers['x-api-key'] as string
      captured.body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
      response.setHeader('content-type', 'application/json'); response.end('{"forwarded":true}')
    })() }); servers.push(upstream)
    const authorization = new CommunityModelAuthorization({ getState: username => ({ username, spaceId: `space-${username}`, disabled: false, sessionEpoch: 0 }) },
      { resolve: token => token === 'opaque-member' ? { username: 'member', spaceId: 'space-member' } : undefined })
    const origin = await hostGateway({ authorization, model: 'deepseek-chat',
      upstream: new StaticCommunityModelUpstream(await listen(upstream), 'shared-provider-fixture') })
    const body = { model: 'deepseek-chat', messages: [{ role: 'user', content: 'hello' }], stream: true }
    const call = (token?: string) => fetch(origin, { method: 'POST', headers: { 'content-type': 'application/json', ...(token === undefined ? {} : { 'x-api-key': token }) }, body: JSON.stringify(body) })
    expect((await call()).status).toBe(401)
    expect((await call('wrong')).status).toBe(401)
    const response = await call('opaque-member')
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ forwarded: true })
    expect(captured).toEqual({ path: '/anthropic/v1/messages', key: 'shared-provider-fixture', body })
  })
  it('refuses disabled and deleted identities using the narrow community store, preserving another caller', async () => {
    const root = await mkdtemp(join(tmpdir(), 'community-gateway-state-'))
    const accounts = new CommunityAccountStore(join(root, 'accounts.db'))
    try {
      for (const username of ['alice', 'bob']) await accounts.create({ username, email: `${username}@example.test`, password: 'password' })
      const access = new FileCommunityModelAccess(join(root, 'model-access.json'))
      const alice = access.forUser('alice', accounts.getState('alice')!.spaceId); const bob = access.forUser('bob', accounts.getState('bob')!.spaceId)
      const upstream = createServer((_request, response) => { response.end('stream-result') }); servers.push(upstream)
      const origin = await hostGateway({ authorization: new CommunityModelAuthorization(accounts, access),
        model: 'deepseek-chat', upstream: new StaticCommunityModelUpstream(await listen(upstream), 'provider-secret') })
      const call = (token: string) => fetch(origin, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': token }, body: '{"model":"deepseek-chat"}' })
      expect(await (await call(alice)).text()).toBe('stream-result')
      await accounts.setDisabled('alice', true)
      expect((await call(alice)).status).toBe(403)
      expect(await (await call(bob)).text()).toBe('stream-result')
      await accounts.delete('alice')
      expect((await call(alice)).status).toBe(403)
      expect((await call(bob)).status).toBe(200)
      await accounts.create({ username: 'alice', email: 'replacement@example.test', password: 'replacement-password' })
      expect((await call(alice)).status).toBe(403)
      const replacement = access.forUser('alice', accounts.getState('alice')!.spaceId)
      expect(replacement).not.toBe(alice)
      expect((await call(replacement)).status).toBe(200)
    } finally { accounts.close(); await rm(root, { recursive: true, force: true }) }
  })

  it('cancels an upstream stream after its downstream disconnects', async () => {
    let ended!: () => void
    const upstreamClosed = new Promise<void>(resolve => { ended = resolve })
    const upstream = createServer((_request, response) => {
      response.setHeader('content-type', 'text/event-stream')
      response.write('data: started\n\n')
      response.once('close', ended)
    }); servers.push(upstream)
    const origin = await hostGateway({ authorization: { authorize: () => 'member' }, model: 'deepseek-chat',
      upstream: new StaticCommunityModelUpstream(await listen(upstream), 'provider-secret') })
    await new Promise<void>((resolve, reject) => {
      const request = httpRequest(origin, { method: 'POST', headers: { 'content-type': 'application/json' } }, response => {
        response.once('data', () => { response.destroy(); resolve() }); response.once('error', reject)
      })
      request.once('error', reject); request.end('{"model":"deepseek-chat","stream":true}')
    })
    await upstreamClosed
  })

  it('rechecks account state after a slow upload before exposing the default upstream', async () => {
    let admitted!: () => void
    const admission = new Promise<void>(resolve => { admitted = resolve })
    let disabled = false
    const authorization = new CommunityModelAuthorization({ getState: username => { admitted(); return { username, spaceId: `space-${username}`, disabled, sessionEpoch: 0 } } },
      { resolve: token => token === 'opaque-member' ? { username: 'member', spaceId: 'space-member' } : undefined })
    const origin = await hostGateway({ authorization, model: 'deepseek-chat' })
    const result = new Promise<number>((resolve, reject) => {
      const request = httpRequest(origin, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'opaque-member' } }, response => {
        response.resume(); resolve(response.statusCode!)
      })
      request.once('error', reject); request.write('{"model":')
      void admission.then(() => { disabled = true; request.end('"deepseek-chat"}') })
    })
    expect(await result).toBe(403)
  })

  it('returns readable failures without forwarding credential-bearing upstream error bodies', async () => {
    const upstream = createServer((_request, response) => { response.writeHead(401, { 'x-fixture-secret': 'provider-secret' }); response.end('provider-secret credential diagnosis') }); servers.push(upstream)
    const origin = await hostGateway({ authorization: { authorize: () => 'member' }, model: 'deepseek-chat',
      upstream: new StaticCommunityModelUpstream(await listen(upstream), 'provider-secret') })
    const call = (body: string, type = 'application/json') => fetch(origin, { method: 'POST', headers: { 'content-type': type }, body })
    expect((await call('not-json')).status).toBe(400)
    expect((await call('{}', 'text/plain')).status).toBe(415)
    expect((await call('{"model":"other"}')).status).toBe(403)
    const response = await call('{"model":"deepseek-chat"}')
    expect(response.status).toBe(502)
    expect(await response.text()).toContain('Default model upstream rejected the request (HTTP 401)')
    expect(response.headers.get('x-fixture-secret')).toBeNull()
    const repeated = await call('{"model":"deepseek-chat"}')
    expect(await repeated.text()).not.toContain('provider-secret')
  })

  it('settles a fetch AbortSignal cancellation without an unhandled connection reset', async () => {
    let closed!: () => void
    const upstreamClosed = new Promise<void>(resolve => { closed = resolve })
    const upstream = createServer((_request, response) => {
      response.setHeader('content-type', 'text/event-stream'); response.write('data: abort-ready\n\n')
      response.once('close', closed)
    }); servers.push(upstream)
    const origin = await hostGateway({ authorization: { authorize: () => 'member' }, model: 'deepseek-chat',
      upstream: new StaticCommunityModelUpstream(await listen(upstream), 'provider-secret') })
    const controller = new AbortController()
    const result = await fetch(origin, { method: 'POST', signal: controller.signal,
      headers: { 'content-type': 'application/json' }, body: '{"model":"deepseek-chat","stream":true}' })
    const reader = result.body!.getReader()
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('abort-ready')
    controller.abort()
    await expect(reader.read()).rejects.toMatchObject({ name: 'AbortError' })
    await upstreamClosed
  })

  it('holds the next model event until a paused downstream drains', async () => {
    let firstWrite!: () => void; const written = new Promise<void>(resolve => { firstWrite = resolve })
    let finished!: () => void; const sent = new Promise<void>(resolve => { finished = resolve })
    const upstream = createServer((_request, response) => {
      response.setHeader('content-type', 'text/event-stream'); response.write('data: first\n\n')
      response.once('finish', finished); void written.then(() => { response.end('data: second\n\n') })
    }); servers.push(upstream)
    class PausedResponse extends EventEmitter {
      destroyed = false; writableFinished = false; readonly output: string[] = []
      writeHead() { return this }
      write(chunk: Buffer) { this.output.push(chunk.toString('utf8')); if (this.output.length === 1) { firstWrite(); return false } return true }
      end() { this.writableFinished = true }
      destroy() { this.destroyed = true; this.emit('close') }
    }
    const response = new PausedResponse()
    const request = Readable.from([Buffer.from('{"model":"deepseek-chat"}')]) as IncomingMessage
    request.method = 'POST'; request.headers = { 'content-type': 'application/json' }
    const handle = createCommunityModelGateway({ authorization: { authorize: () => 'member' }, model: 'deepseek-chat',
      connections: { track: () => {}, untrack: () => {} }, upstream: new StaticCommunityModelUpstream(await listen(upstream), 'provider-secret') })
    const handling = handle(request, response as unknown as ServerResponse)
    await written; await sent; await new Promise<void>(resolve => { setImmediate(resolve) })
    expect(response.output).toEqual(['data: first\n\n']); expect(response.writableFinished).toBe(false)
    response.emit('drain'); await handling
    expect(response.output).toEqual(['data: first\n\n', 'data: second\n\n']); expect(response.writableFinished).toBe(true)
  })

})
