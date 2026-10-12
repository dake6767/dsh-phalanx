import { mkdtemp, rm, readFile, mkdir } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium, type BrowserContext, type Page, type Frame } from 'playwright'
import { expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { platformPluginClient } from './support/platform-client.js'
import { candidateApplication } from './support/candidate-application.js'
import { CommunityAccountStore } from '../src/adapters/community-account-store.js'
import { CommunityRuntimeDriver } from '../src/adapters/community-runtime-driver.js'
import { runtimeSettings } from './support/real-dsh-kit.js'
import { runtimeSection, assertPinnedDshRevision } from './support/real-dsh-runtime.js'
import { signInCommunity } from './fixtures/community-native-browser.js'
import { loopbackPort } from '../src/adapters/loopback-port.js'
import { previewListeners } from './fixtures/preview-listeners.js'

it.each([false, true])('serves private container applications through the production gateway (TLS=%s)', async tls => {
  assertPinnedDshRevision(runtimeSettings)
  const root = await mkdtemp(join(tmpdir(), 'service-preview-'))
  const runtime = runtimeSection(root, 'https://example.test', runtimeSettings)
  const port = await loopbackPort(), previewPort = await loopbackPort()
  const listeners = await previewListeners(tls, port, previewPort), { origin, previewOrigin, cert } = listeners
  const app = candidateApplication({ listen: { host: '127.0.0.1', port, publicOrigin: origin }, preview: { port: previewPort, publicOrigin: previewOrigin }, sessionSecret: 'private-preview-fixture-session-32bytes', runtime })
  const accounts = new CommunityAccountStore(join(root, 'community-accounts.db'))
  for (const username of ['alice', 'bob']) await accounts.create({ username, email: `${username}@example.test`, password: 'password' })
  accounts.close(); await app.start()
  const browser = await chromium.launch({ headless: true })
  const worlds: { context: BrowserContext; page: Page; appPage: Page; frame: Frame; container: string; path: string; space: string }[] = []
  const containerCommand = (container: string, ...args: string[]) => execFileSync('podman', ['exec', container, ...args], { encoding: 'utf8' })
  const sample = await readFile(new URL('./fixtures/preview-service.mjs', import.meta.url))
  try {
    for (const username of ['alice', 'bob']) {
      const context = await browser.newContext({ locale: 'en' }), page = await context.newPage(); page.setDefaultTimeout(30000)
      await signInCommunity(page, origin, username, 'password'); console.info('preview member signed in', tls, username)
      const space = new URL(page.url()).pathname.split('/')[2]!
      const instructions = await (await context.request.get(origin + '/service-preview/')).text()
      const path = instructions.match(new RegExp('/preview/' + space + '/4300/[a-f0-9]{64}/'))![0]
      const ownership = createHash('sha256').update(root).digest('hex')
      const container = execFileSync('podman', ['ps', '--filter', `label=dsh-phalanx.community-root=${ownership}`, '--filter', `label=dsh-phalanx.user=${username}`, '--format', '{{.Names}}'], { encoding: 'utf8' }).trim()
      expect(container).toMatch(/^dsh-phalanx-/u)
      expect((await context.request.get(previewOrigin + path)).status()).toBe(503)
      execFileSync('podman', ['exec', '-i', container, 'sh', '-c', 'cat > /tmp/preview-sample.mjs'], { input: sample })
      execFileSync('podman', ['exec', '-d', '--env', `PREVIEW_BASE=${path}`, container, 'node', '/tmp/preview-sample.mjs'])
      const opening = context.waitForEvent('page'); await page.getByRole('button', { name: 'Service preview', exact: true }).click(); const appPage = await opening
      await appPage.getByRole('heading', { name: 'Instructions for your agent', exact: true }).waitFor()
      await appPage.getByRole('button', { name: 'Open preview', exact: true }).click()
      await appPage.frameLocator('iframe').getByRole('heading', { name: 'Private service preview', exact: true }).waitFor()
      const frame = appPage.frames().find(frame => frame.url().startsWith(previewOrigin))!
      expect(await appPage.evaluate(() => opener)).toBeNull()
      await frame.getByText('HMR READY', { exact: true }).waitFor()
      await frame.evaluate(() => { (window as unknown as { sampleWS: WebSocket }).sampleWS.send('PING') })
      await frame.getByText('PONG', { exact: true }).waitFor()
      containerCommand(container, 'sh', '-c', 'date +%s%N > /tmp/preview-revision')
      await frame.getByText('HMR UPDATED', { exact: true }).waitFor()
      await frame.getByRole('button', { name: 'Check API', exact: true }).click(); await frame.getByText('API OK', { exact: true }).waitFor()
      expect(await frame.evaluate(async () => (await fetch('api')).json())).toEqual({ ok: true, cookie: '', authorization: '' })
      expect(await frame.evaluate(() => { try { return parent.document.cookie } catch { return 'blocked' } })).toBe('blocked')
      expect(await frame.evaluate(() => { try { return document.cookie } catch { return 'blocked' } })).toBe('blocked')
      expect(await frame.evaluate(() => { try { localStorage.setItem('path', location.pathname); return 'stored' } catch { return 'blocked' } })).toBe('blocked')
      expect(await frame.evaluate(async url => { try { await fetch(url + '/account/identity', { credentials: 'include' }); return 'leaked' } catch { return 'blocked' } }, origin)).toBe('blocked')
      expect(await frame.evaluate(async () => { try { await navigator.serviceWorker.register('worker.js'); return 'registered' } catch { return 'blocked' } })).toBe('blocked')
      expect(await frame.evaluate(async () => (await fetch('__activity', { method: 'POST' })).status)).toBe(403)
      const cookie = (await context.cookies(origin)).find(cookie => cookie.name === 'dsh-phalanx_session')!
      expect(cookie.httpOnly).toBe(true); expect(cookie.secure).toBe(tls); expect(cookie.value).not.toBe('forged')
      console.info('preview application passed', tls, username)
      worlds.push({ context, page, appPage, frame, container, path, space })
    }
    const alice = worlds[0]!, bob = worlds[1]!
    const cookies = (await alice.context.cookies(origin)).map(cookie => `${cookie.name}=${cookie.value}`).join('; ')
    const status = async (path: string, from = 'null') => (await alice.context.request.get(previewOrigin + path, { headers: { origin: from } })).status()
    expect(await status(bob.path + 'api')).toBe(403)
    for (const path of [`/preview/${alice.space}/4180/`, `/preview/${alice.space}/22/`, `/preview/${alice.space}/4300/http://10.0.0.1/`, `/preview/${alice.space}/4300/%252e%252e/`]) expect(await status(path)).not.toBe(200)
    expect(await status(alice.path + 'api', origin)).toBe(403)
    expect((await alice.context.request.get(origin + '/account/identity', { headers: { origin: previewOrigin } })).status()).toBe(403)
    expect((await alice.context.request.get(origin + '/account/identity', { headers: { 'sec-fetch-site': 'same-site' } })).status()).toBe(403)
    const rejectedWs = (path: string, from = 'null') => new Promise<number>((resolve, reject) => {
      const socket = new WebSocket(previewOrigin.replace(/^http/u, 'ws') + path, { ca: cert, origin: from, headers: { cookie: cookies } })
      socket.on('unexpected-response', (_request, response) => { response.resume(); socket.terminate(); resolve(response.statusCode!) })
      socket.on('open', () => { socket.close(); reject(Error('Unauthorized preview WS opened')) }); socket.on('error', () => {})
    })
    expect(await rejectedWs(bob.path + 'hmr')).toBe(403)
    expect(await rejectedWs(alice.path + 'hmr', origin)).toBe(403)
    const evidence = process.env.DSH_PHALANX_E2E_EVIDENCE_DIR
    if (evidence) { await mkdir(evidence, { recursive: true }); await alice.appPage.screenshot({ path: join(evidence, `${tls ? 'https' : 'http'}-preview.png`) }) }
    // Service process lifetime is independent of the instance and its preview URL.
    containerCommand(bob.container, 'pkill', '-f', '^node /tmp/preview-sample.mjs$')
    await bob.frame.getByText('DISCONNECTED', { exact: true }).waitFor()
    expect((await bob.context.request.get(previewOrigin + bob.path)).status()).toBe(503)
    execFileSync('podman', ['exec', '-d', '--env', `PREVIEW_BASE=${bob.path}`, bob.container, 'node', '/tmp/preview-sample.mjs'])
    await bob.appPage.reload(); await bob.appPage.frameLocator('iframe').getByText('HMR READY', { exact: true }).waitFor()
    bob.frame = bob.appPage.frames().find(frame => frame.url().startsWith(previewOrigin))!
    // Pause an actual service upgrade; accepted logout must win before the 101.
    containerCommand(bob.container, 'touch', '/tmp/hold-upgrade')
    const bobCookies = (await bob.context.cookies(origin)).map(cookie => `${cookie.name}=${cookie.value}`).join('; ')
    const pending = new WebSocket(previewOrigin.replace(/^http/u, 'ws') + bob.path + 'hmr', { ca: cert, origin: 'null', headers: { cookie: bobCookies } })
    const denied = new Promise<void>((resolve, reject) => { pending.on('error', () => resolve()); pending.on('unexpected-response', (_req, res) => { res.resume(); pending.terminate(); resolve() }); pending.on('open', () => { pending.close(); reject(Error('Revoked upgrade succeeded')) }) })
    await expect.poll(() => containerCommand(bob.container, 'sh', '-c', 'test -f /tmp/upgrade-pending && echo ready || true')).toBe('ready\n')
    await bob.context.request.post(origin + '/logout', { headers: { origin }, maxRedirects: 0 })
    containerCommand(bob.container, 'rm', '/tmp/hold-upgrade'); await denied
    await expect.poll(async () => bob.frame.isDetached() || await bob.frame.getByText('DISCONNECTED', { exact: true }).isVisible().catch(() => false)).toBe(true)
    expect((await bob.context.request.get(previewOrigin + bob.path, { headers: { cookie: bobCookies } })).status()).toBe(403)
    await signInCommunity(bob.page, origin, 'bob', 'password')
    const newInstructions = await (await bob.context.request.get(origin + '/service-preview/')).text()
    bob.path = newInstructions.match(new RegExp('/preview/' + bob.space + '/4300/[a-f0-9]{64}/'))![0]
    containerCommand(bob.container, 'pkill', '-f', '^node /tmp/preview-sample.mjs$')
    execFileSync('podman', ['exec', '-d', '--env', `PREVIEW_BASE=${bob.path}`, bob.container, 'node', '/tmp/preview-sample.mjs'])
    await bob.appPage.goto(`${origin}/service-preview/${bob.space}/4300/`)
    await bob.appPage.frameLocator('iframe').getByText('HMR READY', { exact: true }).waitFor()
    bob.frame = bob.appPage.frames().find(frame => frame.url().startsWith(previewOrigin))!
    const edit = new CommunityAccountStore(join(root, 'community-accounts.db')); await edit.setDisabled('bob', true); edit.close()
    await expect.poll(async () => bob.frame.isDetached() || await bob.frame.getByText('DISCONNECTED', { exact: true }).isVisible().catch(() => false)).toBe(true)
    expect((await bob.context.request.get(previewOrigin + bob.path)).status()).toBe(403)
    // The preview module can fail without taking down account or App Center actions.
    let moduleFailure = 'initialization'
    await alice.context.route('**/plugins/**', async route => {
      if (new URL(route.request().url()).pathname.endsWith('/events')) { await route.continue(); return }
      const response = await route.fetch(), body = await response.text()
      const client = moduleFailure === 'initialization'
        ? platformPluginClient.replace('const openPreview=', "throw Error('fixture preview initialization');const openPreview=")
        : platformPluginClient.replace('function PreviewLink(){', "function PreviewLink(){throw Error('fixture preview render');")
      await route.fulfill({ response, body: body.replace(platformPluginClient, client) })
    })
    for (const failure of ['initialization', 'render']) {
      moduleFailure = failure; await alice.page.reload()
      await alice.page.getByRole('alert').filter({ hasText: 'Service preview is unavailable' }).waitFor()
      await alice.page.getByRole('button', { name: /^Platform account:/u }).click()
      await alice.page.getByRole('menuitem', { name: 'Log out', exact: true }).waitFor(); await alice.page.keyboard.press('Escape')
      await alice.page.getByRole('button', { name: 'Platform App Center', exact: true }).click()
      await alice.page.getByRole('heading', { name: 'Platform App Center', exact: true }).waitFor()
    }
    await alice.context.unroute('**/plugins/**')
    // External top-level entry links retain login/recovery navigation; API/frames remain guarded.
    const external = await alice.context.newPage()
    for (const destination of ['/', '/recovery', `/app/${alice.space}/`]) {
      await external.route('http://external.example.test/', route => route.fulfill({ contentType: 'text/html', body: `<a href="${origin}${destination}">Open platform</a>` }))
      await external.goto('http://external.example.test/')
      const arrival = external.waitForResponse(response => response.url() === origin + destination)
      await external.getByRole('link', { name: 'Open platform' }).click()
      expect((await arrival).status()).toBeLessThan(400)
      await external.unroute('http://external.example.test/')
    }
    await external.close()
    // Preserve the old hostile application even if the trusted wrapper would remove it.
    await alice.appPage.evaluate('clearInterval(timer)')
    // An old live Alice application cannot borrow a later Bob login or shared browser storage.
    await alice.context.request.post(origin + '/logout', { headers: { origin }, maxRedirects: 0 })
    await alice.frame.getByText('DISCONNECTED', { exact: true }).waitFor()
    const enable = new CommunityAccountStore(join(root, 'community-accounts.db')); await enable.setDisabled('bob', false); enable.close()
    await signInCommunity(alice.page, origin, 'bob', 'password')
    const switchedInstructions = await (await alice.context.request.get(origin + '/service-preview/')).text()
    const switchedPath = switchedInstructions.match(new RegExp('/preview/' + bob.space + '/4300/[a-f0-9]{64}/'))![0]
    containerCommand(bob.container, 'pkill', '-f', '^node /tmp/preview-sample.mjs$')
    execFileSync('podman', ['exec', '-d', '--env', `PREVIEW_BASE=${switchedPath}`, bob.container, 'node', '/tmp/preview-sample.mjs'])
    const switched = await alice.context.newPage(); await switched.goto(`${origin}/service-preview/${bob.space}/4300/`)
    await switched.frameLocator('iframe').getByText('HMR READY', { exact: true }).waitFor()
    const switchedFrame = switched.frames().find(frame => frame.url().startsWith(previewOrigin))!
    expect(await switchedFrame.evaluate(() => { try { localStorage.setItem('last-path', location.pathname); return 'stored' } catch { return 'blocked' } })).toBe('blocked')
    expect(await alice.frame.evaluate(() => { try { return localStorage.getItem('last-path') } catch { return 'blocked' } })).toBe('blocked')
    expect(await alice.frame.evaluate(async () => (await fetch('api')).status)).toBe(403)
    expect(await alice.frame.evaluate(async space => (await fetch('/preview/' + space + '/4300/api')).status, bob.space)).toBe(403)
    const retire = new CommunityAccountStore(join(root, 'community-accounts.db')); await retire.delete('bob'); retire.close()
    await expect.poll(async () => switchedFrame.isDetached() || await switchedFrame.getByText('DISCONNECTED', { exact: true }).isVisible().catch(() => false)).toBe(true)
    expect((await alice.context.request.get(previewOrigin + switchedPath + 'api')).status()).toBe(403)
    await switched.close()
    expect(await status(alice.path + 'api')).toBe(403)
  } finally { await browser.close(); await listeners.close(); await app.stop(); await new CommunityRuntimeDriver(runtime).rebuild(); await rm(root, { recursive: true, force: true }) }
}, 180000)
