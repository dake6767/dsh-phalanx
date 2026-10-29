import { createServer } from 'node:http'
import { setImmediate } from 'node:timers/promises'
import { expect, it } from 'vitest'
import { GatewayMcpProbe } from '../src/adapters/mcp-probe.js'
import { McpHttpWire } from '../src/adapters/mcp-wire.js'

it('drains a probe waiting for token issuance and sends no request after stop', async () => {
  let requests = 0,
    release!: (token: string) => void,
    entered!: () => void,
    stopped = false
  const token = new Promise<string>(resolve => {
      release = resolve
    }),
    issuing = new Promise<void>(resolve => {
      entered = resolve
    })
  const server = createServer((_request, response) => {
    requests++
    response.writeHead(503)
    response.end()
  })
  await new Promise<void>(resolve => {
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw Error('No diagnostic listener')
  const probe = new GatewayMcpProbe(
    () => new URL(`http://127.0.0.1:${address.port}`),
    {
      forUser: () => {
        entered()
        return token
      },
    },
    new McpHttpWire(),
  )
  const pending = probe.probe('member', 'space-member', 'fixture')
  const outcome = pending.then(
    () => 'completed',
    () => 'aborted',
  )
  let stopping: Promise<void> | undefined
  try {
    await issuing
    stopping = probe.stop().then(() => {
      stopped = true
    })
    await setImmediate()
    expect(stopped).toBe(false)
    release('fictional-token')
    await stopping
    expect(await outcome).toBe('aborted')
    expect(requests).toBe(0)
    await expect(probe.probe('member', 'space-member', 'fixture')).rejects.toThrow('stopped')
  } finally {
    release('fictional-token')
    await Promise.allSettled([outcome, stopping])
    await probe.stop()
    await new Promise<void>(resolve => {
      server.close(() => {
        resolve()
      })
    })
  }
})
