import { accountState } from './support/account-state.js'
import { createServer, request as httpRequest } from 'node:http'
import { once } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { openUsageRecords } from './support/usage-store.js'
import { CommunityModelAuthorization } from '../src/use-cases/community-model-authorization.js'
import { UsagePolicy } from '../src/use-cases/usage-policy.js'
import { createUsageReportGateway } from '../src/inbound/usage-report-gateway.js'
it('authenticates skill reports again after reading the bounded body and stamps current group and day', async () => {
  const root = mkdtempSync(join(tmpdir(), 'usage-reports-')),
    store = await openUsageRecords(join(root, 'usage.db'))
  let now = 86400001,
    identified = () => {},
    identitySpace = 'space'
  const account = {
    username: 'member',
    spaceId: 'space',
    groupId: 'before',
    disabled: false,
    admin: false,
    sessionEpoch: 0,
    email: '',
    createdAt: 0,
    updatedAt: 0,
  }
  const authorization = new CommunityModelAuthorization(
    accountState(() => account),
    {
      resolve: token => {
        identified()
        return token === 'member-token' ? { username: 'member', spaceId: identitySpace } : undefined
      },
    },
  )
  const usage = new UsagePolicy(
    store,
    { now: () => now },
    { get: async () => account },
    {
      allow() {
        throw Error('Reports cannot request admission')
      },
    },
    undefined,
    { accessible: async () => [{ name: 'held' }] },
  )
  const server = createServer((request, response) => {
    void createUsageReportGateway(authorization, usage)(request, response)
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const origin = `http://127.0.0.1:${
    (
      server.address() as {
        port: number
      }
    ).port
  }`
  const post = (body: unknown, token = 'member-token') =>
    fetch(origin, { method: 'POST', headers: { 'x-api-key': token, 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const delayed = async (change: () => void) => {
    let started!: () => void
    const ready = new Promise<void>(resolve => {
      started = resolve
    })
    identified = started
    const request = httpRequest(origin, { method: 'POST', headers: { 'x-api-key': 'member-token', 'content-type': 'application/json' } })
    const reply = once(request, 'response')
    request.write('{"items":[')
    await ready
    identified = () => {}
    change()
    request.end('{"name":"held","count":1}]}')
    const [response] = await reply
    response.resume()
    await once(response, 'end')
    return response.statusCode
  }
  try {
    expect((await post({ items: [] }, 'bad')).status).toBe(401)
    identitySpace = 'old-space'
    expect((await post({ items: [] })).status).toBe(403)
    identitySpace = 'space'
    expect(
      (
        await post({
          username: 'other',
          day: 0,
          provider: 'forged',
          items: [
            { name: 'held', count: 2 },
            { name: 'unheld', count: 999 },
          ],
        })
      ).status,
    ).toBe(200)
    expect(
      await delayed(() => {
        account.groupId = 'after'
        now = 172800001
      }),
    ).toBe(200)
    expect((await store.reported({})).items).toEqual([
      { username: 'member', day: 172800000, skill: 'held', count: 1 },
      { username: 'member', day: 86400000, skill: 'held', count: 2 },
    ])
    expect((await store.reported({ groupId: 'after' })).items[0]?.count).toBe(1)
    expect(
      await delayed(() => {
        account.disabled = true
      }),
    ).toBe(403)
    account.disabled = false
    expect(
      await delayed(() => {
        account.spaceId = 'replacement'
      }),
    ).toBe(403)
    account.spaceId = 'space'
    expect((await post({ items: [{ name: 'held', count: 0 }] })).status).toBe(400)
    expect((await post({ items: [], padding: 'x'.repeat(32769) })).status).toBe(413)
    for (let i = 0; i < 8; i++) expect((await post({ items: [] })).status).toBe(200)
    expect((await post({ items: [] })).status).toBe(429)
    expect((await store.view({})).total).toBe(0)
    expect((await store.models({})).items).toEqual([])
  } finally {
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
    store.close()
    rmSync(root, { recursive: true, force: true })
  }
})
