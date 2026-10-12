import { createServer } from 'node:http'
import { Script } from 'node:vm'
import { expect, it } from 'vitest'
import { servicePreviewEntry } from '../src/inbound/service-preview-entry.js'
import { ServicePreview } from '../src/use-cases/service-preview.js'
import type { CommunityAccountState } from '../src/domain/community-account.js'

it.each([4180, 4300])('serves an executable wrapper and a usable form when platform port is %s', async excluded => {
  const identity = { userId: 'alice', spaceId: 'a'.repeat(32), sessionEpoch: 0, expiresAt: 1000, key: 'login' }
  const account = { username: 'alice', spaceId: identity.spaceId, sessionEpoch: 0, disabled: false } as CommunityAccountState
  const instance = { userId: 'alice', processId: 1, origin: 'http://runtime', launchUrl: '/', containerName: 'owned' }
  const access = new ServicePreview({ getState: () => account }, { status: () => ({ state: 'ready', instance }) }, { now: () => 1 }, [excluded], { issue: () => 'b'.repeat(64) })
  let origin = new URL('http://127.0.0.1')
  const handler = servicePreviewEntry({ connections: { untrack: () => {} }, dispatch: async () => {}, access, identity: () => identity, origin: () => origin, previewOrigin: 'http://127.0.0.1:4301', available: () => true })
  const server = createServer((request, response) => { void handler(request, response) })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address(); if (!address || typeof address === 'string') throw Error('Missing address')
  origin = new URL(`http://127.0.0.1:${address.port}`)
  try {
    const entry = await fetch(new URL('/service-preview/', origin))
    expect(entry.status).toBe(200)
    expect(await entry.text()).toContain(`value="${excluded === 4300 ? 4301 : 4300}"`)
    const port = excluded === 4300 ? 4301 : 4300
    const response = await fetch(new URL(`/service-preview/${identity.spaceId}/${port}/`, origin))
    const html = await response.text()
    expect(response.status).toBe(200)
    expect(html).toContain('sandbox="allow-scripts allow-forms"')
    for (const match of html.matchAll(/<script>([\s\S]*?)<\/script>/gu)) expect(() => new Script(match[1]!)).not.toThrow()
    const activity = new URL(`/service-preview/${identity.spaceId}/${port}/__activity`, origin)
    expect((await fetch(activity, { method: 'POST' })).status).toBe(403)
    expect((await fetch(activity, { method: 'POST', headers: { origin: origin.origin } })).status).toBe(204)
    expect(access.lastActivity('alice')).toBe(1)
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) }
})
