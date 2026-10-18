import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { createCommunityWebToolsGateway, WEB_TOOLS_MAX_BODY_BYTES } from '../src/inbound/community-web-tools-gateway.js'
import { SharedCommunityWebToolsUpstream, communityWebToolsUpstream } from '../src/adapters/community-web-tools-upstream.js'
import { DEEPSEEK_WEB_TOOLS_HOST } from '../src/dsh/web-tools.js'
import { MemorySessionRegistry } from '../src/adapters/memory-session-registry.js'
import { CommunityModelAccessError } from '../src/domain/community-model.js'
import { communityWebToolsMessage } from '../src/domain/community-web-tools.js'
import type { SharedModelState } from '../src/domain/shared-models.js'
import type { WebToolsOperation } from '../src/ports/community-web-tools.js'

const listen = async (server: Server) => {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}
const readBody = async (request: IncomingMessage) => {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.from(chunk as Uint8Array))
  return Buffer.concat(chunks).toString('utf8')
}
const deepSeekState = (apiKey = 'platform-deepseek-fixture'): SharedModelState => ({ revision: 1, defaultModelId: 'deepseek-chat', providers: [{
  id: 'provider', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/anthropic', apiFormat: 'anthropic-messages', apiKey, enabled: true,
  models: [{ id: 'deepseek-chat', name: 'deepseek-chat', enabled: true, input: 'text' }],
}] })

describe('member web retrieval gateway', () => {
  const servers: Server[] = []
  afterEach(async () => { for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) } })

  const host = async (input: {
    operation?: WebToolsOperation
    fixtures: { state?: SharedModelState, upstream?: (request: IncomingMessage, response: import('node:http').ServerResponse) => void }
    timeoutMs?: number
  }) => {
    let base = 'https://api.deepseek.com/v1/tools'
    if (input.fixtures.upstream !== undefined) {
      const upstream = createServer((request, response) => { void (async () => { input.fixtures.upstream!(request, response) })() })
      servers.push(upstream); base = `${await listen(upstream)}/v1/tools`
    }
    const connections = new MemorySessionRegistry()
    const handle = createCommunityWebToolsGateway({
      authorization: { authorize: token => { if (token !== 'opaque-member') throw new CommunityModelAccessError('unauthenticated'); return 'member' } },
      connections,
      upstream: input.fixtures.upstream === undefined
        ? communityWebToolsUpstream({ read: () => input.fixtures.state ?? deepSeekState() })
        : communityWebToolsUpstream({ read: () => input.fixtures.state ?? deepSeekState() }, base),
      ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
    })
    const operation = input.operation ?? 'search'
    const server = createServer((request, response) => { void handle(request, response, operation) })
    servers.push(server); server.on('connection', socket => connections.registerConnection(socket, true))
    return await listen(server)
  }

  const call = (origin: string, body: string, headers: Record<string, string> = {}) => fetch(origin, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer opaque-member', ...headers }, body,
  })

  it('forwards a sanitized search with the platform key and relays the JSON result', async () => {
    const captured: { path: string | undefined, authorization: string | undefined, body: Record<string, unknown> | undefined } = { path: undefined, authorization: undefined, body: undefined }
    const origin = await host({ fixtures: { upstream: async (request, response) => {
      captured.path = request.url; captured.authorization = request.headers.authorization
      captured.body = JSON.parse(await readBody(request)) as Record<string, unknown>
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ results: [{ title: 'Fixture', url: 'https://example.test/page', snippet: 'fixture snippet', date: null }] }))
    } } })
    const response = await call(origin, JSON.stringify({ query: 'fixture query', count: 8, need_content: true, ori_question: '  how   do I  ', unknown: 'dropped' }))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ results: [{ title: 'Fixture', url: 'https://example.test/page', snippet: 'fixture snippet', date: null }] })
    expect(captured).toEqual({ path: '/v1/tools/search', authorization: 'Bearer platform-deepseek-fixture',
      body: { query: 'fixture query', count: 8, need_content: false, ori_question: 'how do I' } })
  })

  it('normalizes a fetch URL and never accepts a non-HTTP target', async () => {
    const captured: { path: string | undefined, body: Record<string, unknown> | undefined } = { path: undefined, body: undefined }
    const origin = await host({ operation: 'fetch', fixtures: { upstream: async (request, response) => {
      captured.path = request.url; captured.body = JSON.parse(await readBody(request)) as Record<string, unknown>
      response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ content: '# Fixture' }))
    } } })
    expect((await call(origin, JSON.stringify({ url: 'https://example.test/a' }))).status).toBe(200)
    expect(captured).toEqual({ path: '/v1/tools/fetch', body: { url: 'https://example.test/a' } })
    expect((await call(origin, JSON.stringify({ url: 'file:///etc/passwd' }))).status).toBe(400)
    expect((await call(origin, JSON.stringify({ url: 'javascript:alert(1)' }))).status).toBe(400)
  })

  it('rejects unauthenticated callers, wrong methods, media types and malformed bodies', async () => {
    const origin = await host({ fixtures: {} })
    expect((await fetch(origin, { method: 'GET' })).status).toBe(405)
    expect((await fetch(origin, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"query":"x"}' })).status).toBe(401)
    expect((await call(origin, '{"query":"x"}', { authorization: 'Bearer wrong-token' })).status).toBe(401)
    expect((await fetch(origin, { method: 'POST', headers: { 'content-type': 'text/plain', authorization: 'Bearer opaque-member' }, body: '{"query":"x"}' })).status).toBe(415)
    expect((await call(origin, 'not-json')).status).toBe(400)
    expect((await call(origin, '{"query":""}')).status).toBe(400)
    expect((await call(origin, JSON.stringify({ query: 'x'.repeat(WEB_TOOLS_MAX_BODY_BYTES) }))).status).toBe(413)
    expect((await call(origin, JSON.stringify({ query: 'x', count: 51 }))).status).toBe(400)
  })

  it('reports the missing platform credential without naming a member key', async () => {
    const origin = await host({ fixtures: { state: { revision: 1, defaultModelId: null, providers: [] } } })
    const response = await call(origin, JSON.stringify({ query: 'fixture query' }))
    expect(response.status).toBe(503)
    const text = await response.text()
    expect(text).toContain(`credential for ${DEEPSEEK_WEB_TOOLS_HOST}`)
    expect(text).toContain('administrator')
    expect(text).not.toContain('API key')
  })

  it('hides the rejected platform credential behind a platform-facing failure', async () => {
    const origin = await host({ fixtures: { upstream: (_request, response) => { response.writeHead(401); response.end('{"error":"invalid api key"}') } } })
    const response = await call(origin, JSON.stringify({ query: 'fixture query' }))
    expect(response.status).toBe(502)
    const text = await response.text()
    expect(text).toContain(communityWebToolsMessage('credential-rejected'))
    expect(text).not.toContain('platform-deepseek-fixture')
  })

  it('refuses upstream redirects and refused upstream errors as retrieval failures', async () => {
    const redirect = await host({ fixtures: { upstream: (_request, response) => { response.writeHead(302, { location: 'https://evil.example.test/' }); response.end() } } })
    expect((await call(redirect, JSON.stringify({ query: 'fixture query' }))).status).toBe(502)
    const refused = await host({ fixtures: { upstream: (_request, response) => { response.writeHead(400); response.end('{}') } } })
    expect((await call(refused, JSON.stringify({ query: 'fixture query' }))).status).toBe(502)
    const malformed = await host({ fixtures: { upstream: (_request, response) => { response.setHeader('content-type', 'application/json'); response.end('not-json') } } })
    expect((await call(malformed, JSON.stringify({ query: 'fixture query' }))).status).toBe(502)
  })

  it('times out an upstream that does not answer', async () => {
    const origin = await host({ timeoutMs: 20, fixtures: { upstream: () => { /* never answers */ } } })
    expect((await call(origin, JSON.stringify({ query: 'fixture query' }))).status).toBe(504)
  })
})

describe('production retrieval destination', () => {
  const store = { read: () => deepSeekState() }

  it('keeps the official host unless an explicit test-only seam allows another', () => {
    expect(() => new SharedCommunityWebToolsUpstream(store, 'https://mirror.example.test/v1/tools')).toThrow(DEEPSEEK_WEB_TOOLS_HOST)
    expect(() => new SharedCommunityWebToolsUpstream(store, 'https://mirror.example.test/v1/tools', { testOnly: true })).not.toThrow()
  })

  it('sends the production transport to the official operation URL', async () => {
    const calls: string[] = []
    const original = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      calls.push(String(input))
      return new Response('{"results":[]}', { headers: { 'content-type': 'application/json' } })
    }) as typeof fetch
    try { await communityWebToolsUpstream(store).send('search', '{"query":"fixture"}', new AbortController().signal) }
    finally { globalThis.fetch = original }
    expect(calls).toEqual([`https://${DEEPSEEK_WEB_TOOLS_HOST}/v1/tools/search`])
  })

})
