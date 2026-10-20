import { createServer, type Server } from 'node:http'
import { once } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { SqliteUsageRecords } from '../src/adapters/usage-records.js'
import { SharedCommunityModelUpstream } from '../src/adapters/community-model-upstream.js'
import { CommunityModelAuthorization } from '../src/use-cases/community-model-authorization.js'
import { UsagePolicy } from '../src/use-cases/usage-policy.js'
import { createCommunityModelGateway } from '../src/inbound/community-model-gateway.js'
import { usageAdminRoute } from '../src/inbound/usage-admin-route.js'

it('forwards a Messages response unchanged and aggregates only usage under the platform model and starting group', async () => {
  const root = mkdtempSync(join(tmpdir(), 'model-usage-')), store = new SqliteUsageRecords(join(root, 'usage.db'))
  const servers: Server[] = []
  const listen = async (server: Server) => { servers.push(server); server.listen(0, '127.0.0.1'); await once(server, 'listening'); return `http://127.0.0.1:${(server.address() as { port: number }).port}` }
  let allowed = true, receivedRequests = 0, disabled = false
  let groupId = 'before', now = 1000, finishedAt = 1250, contentType = 'application/json'
  let chunks: Buffer[] = [], gate: Promise<void> | undefined, release = () => {}
  const account = (username: string) => ({ username, spaceId: username + '-space', groupId, disabled: username === 'member' && disabled, admin: username === 'admin', sessionEpoch: 0, email: '', createdAt: 0, updatedAt: 0 })
  const actor = { username: 'admin', spaceId: 'admin-space', sessionEpoch: 0 }, usage = new UsagePolicy(store, { now: () => now }, { get: account }, { allow: () => allowed })
  const payload = JSON.stringify({ type: 'message', model: 'upstream-name', content: [{ type: 'text', text: 'PRIVATE_OUTPUT' }], usage: { input_tokens: 10, output_tokens: 12, cache_read_input_tokens: 2, cache_creation_input_tokens: 3 } })
  try {
    chunks = [Buffer.from(payload)]
    const upstream = await listen(createServer((request, response) => { void (async () => { receivedRequests++; request.resume(); groupId = 'after'; now = finishedAt; response.setHeader('content-type', contentType); response.write(chunks[0]!); if (gate) await gate; for (const chunk of chunks.slice(1)) response.write(chunk); response.end() })() }))
    const modelStore = { read: () => ({ revision: 1, defaultModelId: 'model-one', providers: [{ id: 'provider-one', name: 'Provider one', baseUrl: upstream, enabled: true, apiFormat: 'anthropic-messages' as const, apiKey: 'fictional-model-key', models: [{ id: 'model-one', name: 'upstream-name', enabled: true, input: 'text' as const }] }, { id: 'provider-two', name: 'Provider two', baseUrl: upstream, enabled: true, apiFormat: 'anthropic-messages' as const, apiKey: 'fictional-second-key', models: [{ id: 'model-two', name: 'upstream-name', enabled: true, input: 'text' as const }] }] }) }
    const authorization = new CommunityModelAuthorization({ getState: account, get: account }, { resolve: token => token === 'valid' || token === 'retired' ? { username: 'member', spaceId: token === 'valid' ? 'member-space' : 'old-space' } : undefined })
    const gateway = createCommunityModelGateway({ authorization, usage, connections: { track() {}, untrack() {} }, upstream: new SharedCommunityModelUpstream(modelStore) })
    let origin = ''
    origin = await listen(createServer((request, response) => { void (async () => {
      if (request.method === 'POST') await gateway(request, response)
      else if (!await usageAdminRoute(request, response, new URL(request.url!, origin), actor, usage, new URL(origin))) response.writeHead(404).end()
    })() }))
    expect(await (await fetch(origin, { method: 'POST', headers: { 'x-api-key': 'valid', 'content-type': 'application/json' }, body: JSON.stringify({ model: 'model-one', messages: [{ role: 'user', content: 'PRIVATE_REQUEST' }] }) })).text()).toBe(payload)
    const response = await fetch(origin + '/admin/api/usage-models')
    expect(response.status).toBe(200)
    const view = await response.json()
    expect(view.items).toEqual([{ username: 'member', modelId: 'model-one', requests: 1, unknownRequests: 0, deniedRequests: 0, tokens: { input: 10, output: 12, cacheRead: 2, cacheWrite: 3 } }])
    expect(view.summaries.groups).toEqual([{ key: 'before', count: 1 }])
    expect(JSON.stringify(view)).not.toContain('PRIVATE_')
    expect((await (await fetch(origin + '/admin/api/usage-models?groupId=after')).json()).items).toEqual([])
    expect((await (await fetch(origin + '/admin/api/usage-records')).json()).items).toEqual([])
    const sse = Buffer.from('event: message_start\r\ndata: {"type":"message_start",\r\ndata: "message":{"usage":{"input_tokens":10,"output_tokens":1,"cache_read_input_tokens":2,"cache_creation_input_tokens":3}}}\r\n\r\n: heartbeat\r\n\r\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"中 PRIVATE_OUTPUT"}}\r\n\r\ndata: {"type":"message_delta","usage":{"output_tokens":7,"input_tokens":null}}\r\n\r\ndata: {"type":"message_delta","usage":{"output_tokens":12,"cache_read_input_tokens":null}}\r\n\r\ndata: {"type":"message_stop"}\r\n\r\n')
    const split = sse.indexOf(Buffer.from('中')) + 1
    chunks = [sse.subarray(0, split), sse.subarray(split)]; contentType = 'text/event-stream'
    gate = new Promise<void>(resolve => { release = resolve }); groupId = 'stream-before'; now = 3599900; finishedAt = 3600050
    const stream = await fetch(origin, { method: 'POST', headers: { 'x-api-key': 'valid', 'content-type': 'application/json' }, body: '{"model":"model-one","stream":true}' })
    const reader = stream.body!.getReader(), received: Buffer[] = []
    let bytes = 0
    while (bytes < split) { const result = await reader.read(); expect(result.done).toBe(false); received.push(Buffer.from(result.value!)); bytes += result.value!.byteLength }
    expect(Buffer.concat(received)).toEqual(sse.subarray(0, split))
    // Receiving the first bytes before releasing the upstream proves forwarding does not wait for usage completion.
    release()
    for (;;) { const result = await reader.read(); if (result.done) break; received.push(Buffer.from(result.value)) }
    expect(Buffer.concat(received)).toEqual(sse)
    const query = (suffix: string) => fetch(origin + '/admin/api/usage-models' + suffix).then(response => response.json())
    const totals = await query('?groupId=stream-before&from=0&until=3600000')
    expect(totals.items).toEqual([{ username: 'member', modelId: 'model-one', requests: 1, unknownRequests: 0, deniedRequests: 0, tokens: { input: 10, output: 12, cacheRead: 2, cacheWrite: 3 } }])
    expect((await query('?from=3600000&until=7200000')).items).toEqual([])
    expect((await query('')).items[0]).toMatchObject({ requests: 2, tokens: { input: 20, output: 24, cacheRead: 4, cacheWrite: 6 } })
    allowed = false
    const denied = await fetch(origin, { method: 'POST', headers: { 'x-api-key': 'valid', 'content-type': 'application/json' }, body: '{"model":"model-one"}' })
    expect(denied.status).toBe(402)
    expect(await denied.json()).toMatchObject({ type: 'error', code: 'usage-not-allowed', error: { type: 'permission_error', message: 'This use is not allowed.' } })
    expect(receivedRequests).toBe(2)
    expect((await query('')).items[0]).toMatchObject({ requests: 3, unknownRequests: 0, deniedRequests: 1, tokens: { input: 20, output: 24, cacheRead: 4, cacheWrite: 6 } })
    allowed = true; disabled = true
    expect((await fetch(origin, { method: 'POST', headers: { 'x-api-key': 'valid', 'content-type': 'application/json' }, body: '{"model":"model-one"}' })).status).toBe(403)
    expect((await query('')).items[0]).toMatchObject({ requests: 4, unknownRequests: 0, deniedRequests: 2 })
    for (const token of ['invalid', 'retired']) await fetch(origin, { method: 'POST', headers: { 'x-api-key': token, 'content-type': 'application/json' }, body: '{"model":"model-one"}' })
    expect((await query('')).items[0].requests).toBe(4)
    expect(receivedRequests).toBe(2)
    disabled = false
    const other = await fetch(origin, { method: 'POST', headers: { 'x-api-key': 'valid', 'content-type': 'application/json' }, body: '{"model":"model-two","stream":true}' }); await other.text()
    const separate = (await query('')).items
    expect(separate.map((row: { modelId: string }) => row.modelId)).toEqual(['model-one', 'model-two'])
    expect(separate[0]).toMatchObject({ requests: 4, deniedRequests: 2 })
    expect(separate[1]).toMatchObject({ requests: 1, tokens: { input: 10, output: 12, cacheRead: 2, cacheWrite: 3 } })
  } finally { release(); for (const server of servers) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) } store.close(); rmSync(root, { recursive: true, force: true }) }
})

it('preserves forwarded bytes and known counters through malformed, bounded, failed and interrupted responses', async () => {
  const root = mkdtempSync(join(tmpdir(), 'model-usage-failures-')), store = new SqliteUsageRecords(join(root, 'usage.db'))
  const servers: Server[] = []
  const listen = async (server: Server) => { servers.push(server); server.listen(0, '127.0.0.1'); await once(server, 'listening'); return `http://127.0.0.1:${(server.address() as { port: number }).port}` }
  const known = { input: 10, output: 1, cacheRead: 2, cacheWrite: 3 }, absent = { input: null, output: null, cacheRead: null, cacheWrite: null }
  const start = 'data: {"type":"message_start","message":{"usage":{"input_tokens":10,"output_tokens":1,"cache_read_input_tokens":2,"cache_creation_input_tokens":3}}}\n\n'
  const cases = [
    { id: 'partial', type: 'text/event-stream', body: start + 'data: {"type":"message_delta","usage":{"output_tokens":', tokens: known, unknown: 1 },
    { id: 'event-limit', type: 'text/event-stream', body: start + 'data: ' + JSON.stringify({ type: 'message_delta', usage: { output_tokens: 99 }, padding: 'x'.repeat(65536) }) + '\n\n', tokens: known, unknown: 1 },
    { id: 'total-limit', type: 'text/event-stream', body: start + (':' + 'x'.repeat(1024) + '\n\n').repeat(2200) + 'data: {"type":"message_delta","usage":{"output_tokens":99}}\n\n', tokens: known, unknown: 1 },
    { id: 'invalid-json', type: 'application/json', body: 'not-json PRIVATE_OUTPUT', tokens: absent, unknown: 1 },
    { id: 'invalid-counter', type: 'application/json', body: '{"type":"message","usage":{"input_tokens":10,"output_tokens":-1,"cache_read_input_tokens":2,"cache_creation_input_tokens":3}}', tokens: { ...known, output: null }, unknown: 1 },
    { id: 'missing-counter', type: 'application/json', body: '{"type":"message","usage":{"input_tokens":10,"output_tokens":12,"cache_read_input_tokens":null}}', tokens: { input: 10, output: 12, cacheRead: null, cacheWrite: null }, unknown: 1 },
    { id: 'upstream-error', type: 'application/json', body: 'PRIVATE_OUTPUT', tokens: absent, unknown: 1 },
    { id: 'cancelled', type: 'text/event-stream', body: start, tokens: known, unknown: 0 },
  ]
  const account = (username: string) => ({ username, spaceId: username + '-space', groupId: 'group', disabled: false, admin: username === 'admin', sessionEpoch: 0, email: '', createdAt: 0, updatedAt: 0 })
  const actor = { username: 'admin', spaceId: 'admin-space', sessionEpoch: 0 }, usage = new UsagePolicy(store, { now: () => 1000 }, { get: account })
  try {
    const upstream = await listen(createServer((request, response) => { void (async () => {
      let text = ''; for await (const chunk of request) text += chunk
      const selected = cases.find(row => row.id === JSON.parse(text).model)!
      response.statusCode = selected.id === 'upstream-error' ? 503 : 200
      response.setHeader('content-type', selected.type)
      if (selected.id === 'cancelled') response.write(selected.body)
      else response.end(selected.body)
    })() }))
    const modelStore = { read: () => ({ revision: 1, defaultModelId: cases[0]!.id, providers: [{ id: 'provider', name: 'Provider', baseUrl: upstream, enabled: true, apiFormat: 'anthropic-messages' as const, apiKey: 'fictional-model-key', models: cases.map(row => ({ id: row.id, name: row.id, enabled: true, input: 'text' as const })) }] }) }
    const authorization = new CommunityModelAuthorization({ getState: account, get: account }, { resolve: () => ({ username: 'member', spaceId: 'member-space' }) })
    const gateway = createCommunityModelGateway({ authorization, usage, connections: { track() {}, untrack() {} }, upstream: new SharedCommunityModelUpstream(modelStore) })
    const origin = await listen(createServer((request, response) => { void gateway(request, response) }))
    for (const row of cases) {
      const abort = new AbortController()
      const response = await fetch(origin, { method: 'POST', signal: abort.signal, headers: { 'x-api-key': 'valid', 'content-type': 'application/json' }, body: JSON.stringify({ model: row.id, messages: [{ role: 'user', content: 'PRIVATE_REQUEST' }] }) })
      if (row.id === 'cancelled') {
        const reader = response.body!.getReader(); let text = ''
        while (text.length < row.body.length) text += new TextDecoder().decode((await reader.read()).value)
        expect(text).toBe(row.body); abort.abort(); await reader.read().catch(() => undefined)
      } else if (row.id === 'upstream-error') { expect(response.status).toBe(502); expect(await response.text()).not.toContain('PRIVATE_') }
      else { expect(response.status).toBe(200); expect(await response.text()).toBe(row.body) }
      await expect.poll(() => usage.models(actor, { modelId: row.id }).items.length).toBe(1)
      expect(usage.models(actor, { modelId: row.id }).items).toEqual([{ username: 'member', modelId: row.id, requests: 1, unknownRequests: row.unknown, deniedRequests: 0, tokens: row.tokens }])
    }
    expect(usage.view(actor, {}).items).toEqual([])
    expect(JSON.stringify(usage.models(actor, {}))).not.toContain('PRIVATE_')
  } finally { for (const server of servers) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) } store.close(); rmSync(root, { recursive: true, force: true }) }
})
