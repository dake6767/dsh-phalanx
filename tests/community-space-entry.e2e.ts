import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, type Server } from 'node:https'
import { createProxyServer, type ProxyServer } from 'http-proxy-3'
import { chromium, type Browser } from 'playwright'
import { WebSocket } from 'ws'
import type { Duplex } from 'node:stream'
import { afterEach, expect, it } from 'vitest'
import { candidateApplication } from './support/candidate-application.js'
import { CommunityAccountStore } from '../src/adapters/community-account-store.js'
import { CommunityRuntimeDriver } from '../src/adapters/community-runtime-driver.js'
import { loopbackPort } from '../src/adapters/loopback-port.js'
import type { CommunityApplication } from '../src/ports/community-application.js'
import type { CommunityRuntimeConfig } from '../src/domain/community-config.js'
import { startCommunityModel } from './fixtures/community-model.js'
import { signInCommunity, selectCommunityWorkspace, runCommunityTerminal } from './fixtures/community-native-browser.js'
import { newValidationContext, saveBrowserEvidence } from './fixtures/browser-evidence.js'
import { cookieHeader, createBrowserDshRpc } from './support/real-dsh-rpc.js'
import { communityEntryUrl } from './support/community-space.js'
import { runtimeSettings } from './support/real-dsh-kit.js'
import { assertPinnedDshRevision, runtimeSection, defaultWorkspacePath, instanceWorkspacePath } from './support/real-dsh-runtime.js'

let root: string | undefined
let app: CommunityApplication | undefined
let browser: Browser | undefined
let tls: Server | undefined
let proxy: ProxyServer | undefined
let runtime: CommunityRuntimeConfig | undefined
let model: Awaited<ReturnType<typeof startCommunityModel>> | undefined
const connections = new Set<Duplex>()
afterEach(async test => {
  await saveBrowserEvidence(test)
  model?.release(); await browser?.close(); proxy?.close()
  for (const socket of connections) socket.destroy()
  connections.clear()
  if (tls) { tls.closeAllConnections(); await new Promise<void>(resolve => tls!.close(() => resolve())) }
  await app?.stop(); if (runtime) await new CommunityRuntimeDriver(runtime).rebuild()
  await model?.close(); if (root) await rm(root, { recursive: true, force: true })
})

it('serves both native spaces, plugin assets, RPC, manifest and bidirectional WSS through a TLS mount with ownership fences', async () => {
  assertPinnedDshRevision(runtimeSettings)
  root = await mkdtemp(join(tmpdir(), 'community-tls-mount-')); model = await startCommunityModel()
  const cert = join(root, 'fixture.crt'); const key = join(root, 'fixture.key')
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert,
    '-subj', '/CN=localhost', '-addext', 'subjectAltName=IP:127.0.0.1', '-days', '1'], { stdio: 'ignore' })
  const backendPort = await loopbackPort(); proxy = createProxyServer({ target: `http://127.0.0.1:${backendPort}`, ws: true })
  proxy.on('error', (_error, _request, response) => response.destroy())
  tls = createServer({ key: await readFile(key), cert: await readFile(cert) }, (request, response) => proxy!.web(request, response))
  tls.on('connection', socket => { connections.add(socket); socket.once('close', () => connections.delete(socket)) })
  tls.on('upgrade', (request, socket, head) => proxy!.ws(request, socket, head))
  await new Promise<void>(resolve => tls!.listen(0, '127.0.0.1', resolve))
  const address = tls.address(); if (!address || typeof address === 'string') throw new Error('TLS fixture did not listen')
  const origin = `https://127.0.0.1:${address.port}`
  runtime = runtimeSection(root, model.origin, runtimeSettings)
  const config = { listen: { host: '127.0.0.1', port: backendPort, publicOrigin: origin }, sessionSecret: 'community-tls-mount-fixture-32-bytes', runtime,
    modelGateway: { upstreamApiKey: 'community-provider-fixture-key' } }
  app = candidateApplication(config)
  const accounts = new CommunityAccountStore(join(root, 'community-accounts.db'))
  try { for (const username of ['alice', 'bob']) await accounts.create({ username, email: `${username}@example.test`, password: 'password' }) }
  finally { accounts.close() }
  await app.start()
  // This isolated certificate exercises encrypted transport, not deployment certificate issuance.
  browser = await chromium.launch({ headless: true })
  const worlds = []
  for (const username of ['alice', 'bob']) {
    const context = await newValidationContext(browser, { ignoreHTTPSErrors: true }); const page = await context.newPage(); page.setDefaultTimeout(30_000)
    const resources: string[] = []; const sockets: string[] = []; const frames: string[] = []
    let nativeRequests = false
    page.on('request', request => {
      nativeRequests ||= new URL(request.url()).pathname.startsWith('/app/')
      if (nativeRequests) resources.push(request.url())
    })
    page.on('websocket', socket => { sockets.push(socket.url()); socket.on('framesent', frame => frames.push(`sent ${String(frame.payload)}`)); socket.on('framereceived', frame => frames.push(`received ${String(frame.payload)}`)) })
    await signInCommunity(page, origin, username, 'password')
    const cookie = await cookieHeader(context, origin); const entry = communityEntryUrl(origin, cookie)
    expect(page.url()).toBe(entry)
    try { await selectCommunityWorkspace(context, page, origin, instanceWorkspacePath(defaultWorkspacePath(root, username), runtime.container !== undefined), runtime.container !== undefined) }
    catch (error) { throw new Error(`Native TLS workspace admission failed for ${username}`, { cause: error }) }
    await expect.poll(() => resources.some(url => new URL(url).pathname.includes('/plugins/'))).toBe(true)
    const cdp = await context.newCDPSession(page)
    const manifest = await cdp.send('Page.getAppManifest') as { manifest?: { id?: string, scope?: string, startUrl?: string } }
    expect([manifest.manifest?.id, manifest.manifest?.scope, manifest.manifest?.startUrl]).toEqual([entry, entry, entry])
    expect(sockets.some(url => url.startsWith(entry.replace(/^https/u, 'wss')) && url.endsWith('/api/remote.mux'))).toBe(true)
    await expect.poll(() => frames.some(frame => frame.startsWith('sent ') && frame.includes('"type":"open"'))).toBe(true)
    await expect.poll(() => frames.some(frame => frame.startsWith('received ') && frame.includes('"type":"item"'))).toBe(true)
    expect(resources.filter(url => !url.startsWith(entry))).toEqual([])
    const internal = await page.evaluate(async mount => {
      const initial = location.href
      history.pushState(null, '', `${mount}session/42`)
      try {
        const response = await fetch('api/session/create', { method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ type: 'client-request', rpcId: 'mounted-relative-session', method: 'session/create', payload: { args: { request: {} } } }) })
        return { base: document.baseURI, body: await response.json() as { result: { ok: boolean } } }
      } finally { history.replaceState(null, '', initial) }
    }, new URL(entry).pathname)
    expect(internal.base).toBe(entry); expect(internal.body.result.ok).toBe(true)
    const runtimeCookies = (await context.cookies(entry)).filter(row => !row.name.startsWith('dsh-phalanx_'))
    expect(runtimeCookies.length).toBeGreaterThan(0)
    expect(runtimeCookies.every(row => row.path === new URL(entry).pathname && row.secure)).toBe(true)
    await runCommunityTerminal(page, "printf 'MOUNT_TERMINAL_%s' OK", 'MOUNT_TERMINAL_OK')
    await page.locator('[data-composer-input]').fill('STREAM_MODEL_TASK'); await page.locator('[data-composer-input]').press('Enter')
    await page.getByText('COMMUNITY_', { exact: true }).waitFor()
    worlds.push({ context, page, cookie, entry, resources })
  }
  model.release()
  for (const world of worlds) await world.page.locator('p').filter({ hasText: 'COMMUNITY_MODEL_READY' }).last().waitFor()
  const alice = worlds[0]!; const bob = worlds[1]!
  expect((await alice.context.request.get(bob.entry)).status()).toBe(403)
  const crossed = await new Promise<number>((resolve, reject) => {
    const socket = new WebSocket(`${bob.entry.replace(/^https/u, 'wss')}api/remote.mux`, { rejectUnauthorized: false, headers: { cookie: alice.cookie } })
    socket.once('unexpected-response', (_request, response) => { response.resume(); resolve(response.statusCode!) })
    socket.once('open', () => { socket.close(); reject(new Error('Another member WebSocket was admitted')) }); socket.once('error', reject)
  })
  expect(crossed).toBe(403)
  for (const world of worlds) {
    // DSH's documented shell paths and query/hash bookmarks stay within the space.
    const bookmark = `${world.entry}index.html?view=workspace#bookmark`
    await world.page.goto(bookmark); await world.page.reload()
    await world.page.getByRole('treeitem').filter({ has: world.page.getByText('COMMUNITY_TITLE', { exact: true }) }).last().click()
    await world.page.locator('p').filter({ hasText: 'COMMUNITY_MODEL_READY' }).last().waitFor()
    await expect.poll(() => world.page.locator('[data-composer-input]').getAttribute('contenteditable')).toBe('true')
    expect(world.page.url()).toBe(bookmark)
    expect(await createBrowserDshRpc(world.context).remoteRpc(origin, await cookieHeader(world.context, origin), 'session/modelCatalog', {})).toBeTruthy()
    expect(world.resources.filter(url => !url.startsWith(world.entry))).toEqual([])
  }
  await app.stop(); app = candidateApplication(config); await app.start()
  for (const world of worlds) {
    await signInCommunity(world.page, origin, world === alice ? 'alice' : 'bob', 'password')
    expect(world.page.url()).toBe(world.entry)
    await world.page.getByRole('treeitem').filter({ has: world.page.getByText('COMMUNITY_TITLE', { exact: true }) }).last().click()
    await world.page.locator('p').filter({ hasText: 'COMMUNITY_MODEL_READY' }).last().waitFor()
    expect(await createBrowserDshRpc(world.context).remoteRpc(origin, await cookieHeader(world.context, origin), 'session/modelCatalog', {})).toBeTruthy()
  }
}, 600_000)
