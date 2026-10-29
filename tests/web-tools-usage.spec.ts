import { accountState } from './support/account-state.js'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createCommunityWebToolsGateway } from '../src/inbound/community-web-tools-gateway.js'
import { CommunityModelAuthorization } from '../src/use-cases/community-model-authorization.js'
import { UsagePolicy } from '../src/use-cases/usage-policy.js'
import { openUsageRecords } from './support/usage-store.js'
it('records retrieval outcomes and neutral admission refusals without queries, targets or results', async () => {
  const root = mkdtempSync(join(tmpdir(), 'web-usage-')),
    store = await openUsageRecords(join(root, 'usage.db'))
  let allowed = true,
    disabled = false,
    status = 200,
    groupId = 'before',
    received = 0,
    hold = false
  let entered!: () => void
  const arrived = new Promise<void>(resolve => {
    entered = resolve
  })
  const account = async () => ({ username: 'member', spaceId: 'space', groupId, admin: true, disabled, sessionEpoch: 0, email: '', createdAt: 0, updatedAt: 0 })
  const usage = new UsagePolicy(store, { now: () => 1000 }, { get: account }, { allow: () => allowed })
  const authorization = new CommunityModelAuthorization(accountState(account), {
    resolve: token => (token === 'member' ? { username: 'member', spaceId: 'space' } : undefined),
  })
  const handle = createCommunityWebToolsGateway({
    authorization,
    usage,
    connections: { track() {}, untrack() {} },
    upstream: {
      send: async (_operation, _body, signal) => {
        received++
        if (hold) {
          entered()
          await new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
        }
        groupId = 'after'
        return new Response('{"content":"PRIVATE_RESULT"}', { status })
      },
    },
  })
  const server = createServer((request, response) => {
    void handle(request, response, request.url === '/fetch' ? 'fetch' : 'search')
  })
  try {
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const origin = `http://127.0.0.1:${
      (
        server.address() as {
          port: number
        }
      ).port
    }`
    const send = (path = '/search', token = 'member') =>
      fetch(origin + path, {
        method: 'POST',
        headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
        body: JSON.stringify(path === '/fetch' ? { url: 'https://example.test/PRIVATE_TARGET' } : { query: 'PRIVATE_QUERY', ori_question: 'PRIVATE_QUESTION' }),
      })
    expect((await send()).status).toBe(200)
    status = 503
    expect((await send('/fetch')).status).toBe(502)
    status = 429
    expect((await send()).status).toBe(429)
    allowed = false
    const denied = await send()
    expect(denied.status).toBe(403)
    expect(await denied.json()).toMatchObject({ code: 'usage-not-allowed', error: 'This use is not allowed.' })
    allowed = true
    disabled = true
    expect((await send()).status).toBe(403)
    disabled = false
    expect((await send('/search', 'invalid')).status).toBe(401)
    expect(received).toBe(3)
    const records = await usage.view({ username: 'member', spaceId: 'space', sessionEpoch: 0 }, {})
    expect(records.total).toBe(5)
    expect(records.items.find(row => row.outcome === 'succeeded')).toMatchObject({
      groupId: 'before',
      capability: { kind: 'web-tools', id: 'web-tools', operation: 'search' },
      httpStatus: 200,
    })
    expect(
      records.items
        .filter(row => row.outcome === 'failed')
        .map(row => row.httpStatus)
        .sort(),
    ).toEqual([429, 502])
    expect(records.items.filter(row => row.outcome === 'denied')).toHaveLength(2)
    expect(JSON.stringify(records)).not.toContain('PRIVATE_')
    hold = true
    const controller = new AbortController()
    const interrupted = fetch(origin + '/search', {
      method: 'POST',
      signal: controller.signal,
      headers: { authorization: 'Bearer member', 'content-type': 'application/json' },
      body: '{"query":"PRIVATE_CANCELLED_QUERY"}',
    }).catch(() => undefined)
    await arrived
    controller.abort()
    await interrupted
    await expect.poll(async () => (await usage.view({ username: 'member', spaceId: 'space', sessionEpoch: 0 }, {})).total).toBe(6)
    const cancelled = (await usage.view({ username: 'member', spaceId: 'space', sessionEpoch: 0 }, {})).items[0]
    expect(cancelled).toMatchObject({ outcome: 'failed', reason: 'cancelled' })
    expect(cancelled).not.toHaveProperty('httpStatus')
  } finally {
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
    store.close()
    rmSync(root, { recursive: true, force: true })
  }
})
