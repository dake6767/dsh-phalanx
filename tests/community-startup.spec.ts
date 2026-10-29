import { mkdtemp } from 'node:fs/promises'
import { createServer, request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { readBootstrapCredential } from '../src/adapters/bootstrap-credential.js'
import type { CommunityStartupStage } from '../src/domain/admin-contract.js'
import type { CommunityRuntimeDriverPort } from '../src/ports/community-runtime-driver.js'
import { CommunityInstanceLifecycle } from '../src/use-cases/community-instance-lifecycle.js'
import { removeCommunityFixture } from './fixtures/owned-cleanup.js'
import { createCommunityApplication } from './support/community-application.js'

it('starts only for own-space navigation, shares the overlay and exchanges cookies on each browser first ready navigation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'startup-entry-'))
  let release!: () => void,
    entered!: () => void,
    starts = 0,
    launches = 0,
    allowStart = false
  const gate = new Promise<void>(resolve => {
    release = resolve
  })
  const began = new Promise<void>(resolve => {
    entered = resolve
  })
  let report: (stage: CommunityStartupStage) => void = () => {}
  const forwarded: string[] = []
  const target = createServer((request, response) => {
    forwarded.push(request.method ?? 'GET')
    if (request.url?.startsWith('/launch')) {
      response.writeHead(303, { location: '/', 'set-cookie': `fixture_dsh=ready-${++launches}; Path=/; HttpOnly` })
      response.end()
      return
    }
    if (!/fixture_dsh=ready-\d+/u.test(request.headers.cookie ?? '')) {
      response.writeHead(401)
      response.end('Missing native session')
      return
    }
    response.writeHead(200, { 'content-type': 'text/html', 'set-cookie': 'fixture_extra=scope; Path=/; HttpOnly' })
    response.end('<div id="root">Native workspace</div>')
  })
  await new Promise<void>(resolve => {
    target.listen(0, '127.0.0.1', resolve)
  })
  const address = target.address()
  if (!address || typeof address === 'string') throw new Error('No fixture listener')
  const targetOrigin = `http://127.0.0.1:${address.port}`
  const driver: CommunityRuntimeDriverPort = {
    rebuild: async () => [],
    alive: async () => true,
    stop: async () => {},
    detach: async () => {},
    start: async (userId, _authority, _access, _signal, progress) => {
      starts++
      if (!allowStart) throw new Error('Non-navigation must not start a carrier')
      report = progress ?? (() => {})
      entered()
      await gate
      return { userId, processId: 100 + starts, origin: targetOrigin, launchUrl: targetOrigin + '/launch' }
    },
  }
  const runtime = new CommunityInstanceLifecycle(driver, async () => ({ url: targetOrigin, token: 'fictional' }))
  const app = createCommunityApplication(
    {
      listen: { host: '127.0.0.1', port: 0 },
      sessionSecret: 'startup-fixture-session-secret-32-bytes',
      idleReclaimSeconds: 0,
      runtime: {
        command: process.execPath,
        args: [],
        dataRoot: root,
        defaultModel: { provider: 'deepseek-official', model: 'fixture', upstream: { baseUrl: targetOrigin } },
      },
    },
    { runtime },
  )
  try {
    const origin = await app.start()
    const pairs = (response: Response) =>
      response.headers
        .getSetCookie()
        .map(cookie => cookie.split(';')[0])
        .join('; ')
    const bootstrap = await fetch(origin + '/bootstrap', {
      method: 'POST',
      redirect: 'manual',
      headers: { origin, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ credential: readBootstrapCredential(root)!.credential, username: 'admin', password: 'password' }),
    })
    const admin = pairs(bootstrap),
      members = []
    for (const username of ['alice', 'bob']) {
      const created = await fetch(origin + '/admin/api/accounts', {
        method: 'POST',
        headers: { cookie: admin, origin, 'content-type': 'application/json' },
        body: JSON.stringify({ username, password: 'password', email: '' }),
      })
      expect(created.status).toBe(201)
      const account = (await created.json()) as { spaceId: string }
      const login = await fetch(origin + '/login', {
        method: 'POST',
        redirect: 'manual',
        headers: { origin, 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ username, password: 'password' }),
      })
      expect(login.status).toBe(303)
      expect(login.headers.get('location')).toBe(`/app/${account.spaceId}/`)
      expect(login.headers.getSetCookie().some(cookie => cookie.startsWith('fixture_dsh='))).toBe(false)
      members.push({ cookie: pairs(login), path: `/app/${account.spaceId}/` })
    }
    const alice = members[0]!,
      bob = members[1]!
    for (const method of ['GET', 'POST']) {
      const response = await fetch(origin + alice.path + 'api/task', { method, headers: { cookie: alice.cookie, origin, accept: 'application/json' } })
      expect(response.status).toBe(503)
      expect(await response.text()).not.toContain('<html')
    }
    expect(starts).toBe(0)
    expect((await fetch(origin + bob.path, { headers: { cookie: alice.cookie, accept: 'text/html' } })).status).toBe(403)
    const wsStatus = await new Promise<number>((resolve, reject) => {
      const socket = new WebSocket(origin.replace(/^http/u, 'ws') + alice.path + 'api/remote.mux', { headers: { cookie: alice.cookie } })
      socket.once('unexpected-response', (_request, response) => {
        response.resume()
        resolve(response.statusCode!)
      })
      socket.once('open', () => {
        socket.close()
        reject(new Error('Cold WebSocket was admitted'))
      })
      socket.once('error', reject)
    })
    expect(wsStatus).toBe(503)
    expect(starts).toBe(0)
    allowStart = true
    const first = await fetch(origin + alice.path, { headers: { cookie: alice.cookie, accept: 'text/html' } })
    expect(first.status).toBe(200)
    expect(await first.text()).toContain('data-platform-startup')
    await began
    const navigate = (url: string, options: { method?: string; headers: Record<string, string>; body?: string }) =>
      new Promise<Response>((resolve, reject) => {
        const outgoing = httpRequest(url, options, response => {
          const chunks: Buffer[] = []
          response.on('data', chunk => chunks.push(Buffer.from(chunk)))
          response.on('end', () => {
            resolve(new Response(Buffer.concat(chunks), { status: response.statusCode!, headers: response.headers as Record<string, string> }))
          })
        })
        outgoing.on('error', reject)
        outgoing.end(options.body)
      })
    const same = await navigate(origin + alice.path + '?tab=2', { headers: { cookie: alice.cookie, 'sec-fetch-mode': 'navigate' } })
    expect(await same.text()).toContain('data-platform-startup')
    expect(starts).toBe(1)
    const post = await navigate(origin + alice.path + '?submitted=1', {
      method: 'POST',
      headers: { cookie: alice.cookie, origin, 'sec-fetch-mode': 'navigate' },
      body: 'do-not-replay',
    })
    expect(post.status).toBe(200)
    expect(await post.text()).toContain('data-platform-startup')
    expect(forwarded).toEqual([])
    const status = async (cookie: string, suffix = '') => (await fetch(origin + '/account/startup' + suffix, { headers: { cookie } })).json()
    expect(await status(alice.cookie)).toEqual({ state: 'preparing' })
    report('starting')
    expect(await status(alice.cookie)).toEqual({ state: 'starting' })
    report('connecting')
    expect(await status(alice.cookie)).toEqual({ state: 'connecting' })
    expect(await status(bob.cookie, '?username=alice')).toEqual({ state: 'preparing' })
    release()
    await expect.poll(async () => (await status(alice.cookie)).state).toBe('ready')
    const ready = await fetch(origin + alice.path, { headers: { cookie: alice.cookie, accept: 'text/html' } })
    expect(ready.status).toBe(200)
    expect(await ready.text()).toContain('Native workspace')
    expect(ready.headers.getSetCookie()).toContain(`fixture_dsh=ready-1; Path=${alice.path}; HttpOnly`)
    expect(ready.headers.getSetCookie()).toContain(`fixture_extra=scope; Path=${alice.path}; HttpOnly`)
    const admitted = alice.cookie + '; ' + pairs(ready)
    await (await fetch(origin + alice.path, { headers: { cookie: admitted, accept: 'text/html' } })).text()
    expect(launches).toBe(1)
    const secondBrowser = await fetch(origin + alice.path, { headers: { cookie: alice.cookie, accept: 'text/html' } })
    expect(secondBrowser.status).toBe(200)
    await secondBrowser.text()
    expect(launches).toBe(2)
    expect(forwarded).not.toContain('POST')
  } finally {
    release()
    await app.stop()
    target.closeAllConnections()
    await new Promise<void>((resolve, reject) => {
      target.close(error => {
        if (error) reject(error)
        else resolve()
      })
    })
    await removeCommunityFixture(root)
  }
})
