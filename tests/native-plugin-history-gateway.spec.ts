import { createServer } from 'node:http'
import { expect, it } from 'vitest'
import { createNativePluginHistoryGateway } from '../src/inbound/native-plugin-history-gateway.js'

it('derives history identity from the member token, reauthorizes after the body, and refuses submitted bundle claims', async () => {
  const calls: unknown[] = []
  let authorizations = 0
  const handler = createNativePluginHistoryGateway(
    {
      currentMember: async () => {
        authorizations++
        return { username: 'member', spaceId: 'space' }
      },
    },
    {
      request: async (...args) => {
        calls.push(args.slice(0, 3))
        return ['observed-package']
      },
    },
  )
  const server = createServer((request, response) => {
    void handler(request, response)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as { port: number }
  try {
    const url = `http://127.0.0.1:${address.port}/native-plugin-history`
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'x-api-key': 'fixture', 'content-type': 'application/json' },
      body: JSON.stringify({ generation: 'launch', mode: 'refresh' }),
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ names: ['observed-package'] })
    expect(authorizations).toBe(2)
    expect(calls).toEqual([[{ username: 'member', spaceId: 'space' }, 'launch', 'refresh']])
    const forged = await fetch(url, {
      method: 'POST',
      headers: { 'x-api-key': 'fixture', 'content-type': 'application/json' },
      body: JSON.stringify({ generation: 'launch', mode: 'refresh', names: ['forged'] }),
    })
    expect(forged.status).toBe(400)
    expect(calls).toHaveLength(1)
  } finally {
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})
