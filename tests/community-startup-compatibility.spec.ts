import { expect, it } from 'vitest'
import { CommunityLifecycle } from '../src/composition/community-lifecycle.js'
import type { CommunityRuntimePort } from '../src/ports/community-runtime.js'

it('does not open an entry after shutdown interrupts asynchronous bootstrap checks', async () => {
  let finish!: () => void; const check = new Promise<void>(resolve => { finish = resolve })
  let listeners = 0; let closed = false
  const instance = { userId: 'member', origin: 'http://example.test', launchUrl: 'http://example.test', processId: 1 }
  const runtime: CommunityRuntimePort = { ensure: async () => instance, restart: async () => instance, recover: async () => instance, reclaim: async () => 'not-running', terminate: async () => {}, status: () => ({ state: 'stopped' }), stopAll: async () => {}, reconcileStartupContainers: async () => ({ adopted: [], swept: [] }) }
  const app = new CommunityLifecycle({ config: { listen: { host: '127.0.0.1', port: 0 }, sessionSecret: 'startup-fixture-secret', runtime: { command: '/unused', args: [], dataRoot: '/unused', defaultModel: { provider: 'fixture', model: 'fixture', upstream: { baseUrl: 'https://example.test' } } } },
    runtime, knownUsers: () => new Set(), connections: { closeAll: () => {} }, createListener: () => { listeners++; throw Error('must not listen') }, checkIdle: async () => {}, prepareBootstrap: () => check,
    closeResources: async () => { finish(); await check; closed = true },
  })
  const starting = app.start().catch(error => error)
  await app.stop()
  expect((await starting).message).toContain('stopped during bootstrap')
  expect(closed).toBe(true); expect(listeners).toBe(0); expect(app.recordsReady()).toBe(false)
})
