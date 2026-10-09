import { createServer } from 'node:http'
import { once } from 'node:events'
import { expect, it } from 'vitest'
import { managedPluginFailures } from '../src/adapters/managed-plugin-status.js'
it('cancels a stalled launch-token exchange and releases the active request', async () => {
  let received!: () => void
  const admitted = new Promise<void>(resolve => { received = resolve })
  let closed!: () => void
  const disconnected = new Promise<void>(resolve => { closed = resolve })
  const server = createServer(request => { request.on('close', closed); received() })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const address = server.address() as { port: number }
  const origin = new URL(`http://127.0.0.1:${address.port}`)
  const controller = new AbortController()
  try {
    const pending = managedPluginFailures({ userId: 'member', processId: 1, launchUrl: origin.href, origin: origin.origin }, origin, { plugin: '/artifact/' }, controller.signal)
    const assertion = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    await admitted; controller.abort(); await assertion; await disconnected
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) }
})
