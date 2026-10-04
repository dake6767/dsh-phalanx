import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, expect, it } from 'vitest'
import { SharedCommunityModelUpstream } from '../src/adapters/community-model-upstream.js'
import { createCommunityModelGateway } from '../src/inbound/community-model-gateway.js'
import type { SharedModelState } from '../src/domain/shared-models.js'

const servers: Server[] = []
afterEach(async () => { for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) } })
const listen = async (server: Server) => {
  servers.push(server); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

it('routes identical model names independently and preserves an admitted stream when supply changes', async () => {
  const seen: { path: string, key: string, model: string }[] = []
  let finish!: () => void
  const upstream = await listen(createServer((request, response) => { void (async () => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const body = JSON.parse(Buffer.concat(chunks).toString()) as { model: string }
    seen.push({ path: request.url!, key: request.headers['x-api-key'] as string, model: body.model })
    response.setHeader('content-type', 'text/event-stream'); response.write('data: started\n\n')
    if (request.url === '/coding/v1/messages') finish = () => response.end('data: finished\n\n')
    else response.end('data: second-provider\n\n')
  })() }))
  let state: SharedModelState = { revision: 1, defaultModelId: 'first-model', providers: [
    { id: 'first', name: 'First', baseUrl: `${upstream}/coding`, apiFormat: 'anthropic-messages', apiKey: 'first-key', enabled: true,
      models: [{ id: 'first-model', name: 'same-name', enabled: true }] },
    { id: 'second', name: 'Second', baseUrl: `${upstream}/other`, apiFormat: 'anthropic-messages', apiKey: 'second-key', enabled: true,
      models: [{ id: 'second-model', name: 'same-name', enabled: true }] },
  ] }
  const handle = createCommunityModelGateway({ authorization: { authorize: () => 'member' },
    connections: { track: () => {}, untrack: () => {} }, upstream: new SharedCommunityModelUpstream({ read: () => state }) })
  const origin = await listen(createServer((request, response) => { void handle(request, response) }))
  const call = (model: string) => fetch(origin, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model, stream: true }) })
  const admitted = await call('first-model'); const reader = admitted.body!.getReader()
  expect(new TextDecoder().decode((await reader.read()).value)).toContain('started')
  state = { ...state, revision: 2, defaultModelId: 'second-model', providers: state.providers.filter(provider => provider.id !== 'first') }
  const denied = await call('first-model')
  expect(denied.status).toBe(403); expect(await denied.text()).toContain('Select an enabled shared model')
  finish(); expect(new TextDecoder().decode((await reader.read()).value)).toContain('finished')
  expect((await reader.read()).done).toBe(true)
  expect(await (await call('second-model')).text()).toContain('second-provider')
  expect(seen).toEqual([{ path: '/coding/v1/messages', key: 'first-key', model: 'same-name' },
    { path: '/other/v1/messages', key: 'second-key', model: 'same-name' }])
})
