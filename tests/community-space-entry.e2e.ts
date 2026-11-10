// Validation: T2; real credentials: none; actual Linux rootless DSH. Missing inputs must fail the T2 report gate.
import { createProxyServer, type ProxyServer } from 'http-proxy-3'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:https'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Duplex } from 'node:stream'
import { chromium, type Browser } from 'playwright'
import { afterEach, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { CommunityRuntimeDriver } from '../src/adapters/community-runtime-driver.js'
import { loopbackPort } from '../src/adapters/loopback-port.js'
import type { CommunityRuntimeConfig } from '../src/domain/community-config.js'
import type { CommunityApplication } from '../src/ports/community-application.js'
import { newValidationContext, saveBrowserEvidence } from './fixtures/browser-evidence.js'
import { startCommunityModel } from './fixtures/community-model.js'
import { openCommunityAccountMenu, runCommunityTerminal, selectCommunityWorkspace, signInCommunity } from './fixtures/community-native-browser.js'
import { removeCommunityFixture } from './fixtures/owned-cleanup.js'
import { candidateApplication } from './support/candidate-application.js'
import { openTestAccounts } from './support/community-application.js'
import { communityEntryUrl } from './support/community-space.js'
import { runtimeSettings } from './support/real-dsh-kit.js'
import { latestHumanText } from './support/real-dsh-model.js'
import { cookieHeader, createBrowserDshRpc } from './support/real-dsh-rpc.js'
import { assertPinnedDshRevision, defaultWorkspacePath, instanceWorkspacePath, runtimeSection } from './support/real-dsh-runtime.js'

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
  model?.release()
  await browser?.close()
  proxy?.close()
  for (const socket of connections) socket.destroy()
  connections.clear()
  if (tls) {
    tls.closeAllConnections()
    await new Promise<void>(resolve => tls!.close(() => resolve()))
  }
  await app?.stop()
  if (runtime) await new CommunityRuntimeDriver(runtime).rebuild()
  await model?.close()
  if (root) await removeCommunityFixture(root)
})

it('serves both native spaces, plugin assets, RPC, manifest and bidirectional WSS through a TLS mount with ownership fences', async () => {
  assertPinnedDshRevision(runtimeSettings)
  root = await mkdtemp(join(tmpdir(), 'community-tls-mount-'))
  model = await startCommunityModel()
  const cert = join(root, 'fixture.crt')
  const key = join(root, 'fixture.key')
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      key,
      '-out',
      cert,
      '-subj',
      '/CN=localhost',
      '-addext',
      'subjectAltName=IP:127.0.0.1',
      '-days',
      '1',
    ],
    { stdio: 'ignore' },
  )
  const backendPort = await loopbackPort()
  proxy = createProxyServer({ target: `http://127.0.0.1:${backendPort}`, ws: true })
  proxy.on('error', (_error, _request, response) => response.destroy())
  tls = createServer({ key: await readFile(key), cert: await readFile(cert) }, (request, response) => proxy!.web(request, response))
  tls.on('connection', socket => {
    connections.add(socket)
    socket.once('close', () => connections.delete(socket))
  })
  const upgradedConnections = new Set<Duplex>()
  tls.on('upgrade', (request, socket, head) => {
    upgradedConnections.add(socket)
    socket.once('close', () => upgradedConnections.delete(socket))
    proxy!.ws(request, socket, head)
  })
  await new Promise<void>(resolve => tls!.listen(0, '127.0.0.1', resolve))
  const address = tls.address()
  if (!address || typeof address === 'string') throw new Error('TLS fixture did not listen')
  const origin = `https://127.0.0.1:${address.port}`
  runtime = runtimeSection(root, model.origin, runtimeSettings)
  const config = {
    listen: { host: '127.0.0.1', port: backendPort, publicOrigin: origin },
    sessionSecret: 'community-tls-mount-fixture-32-bytes',
    runtime,
    modelGateway: { upstreamApiKey: 'community-provider-fixture-key' },
  }
  app = candidateApplication(config)
  const accounts = await openTestAccounts(root)
  const adminUsername = 'workspace-administrator-www-west'
  await accounts.createFirstAdmin({ username: adminUsername, email: '', password: 'password' })
  try {
    for (const username of ['alice', 'bob']) await accounts.create({ username, email: `${username}@example.test`, password: 'password' })
  } finally {
    await accounts.close()
  }
  await app.start()
  // This isolated certificate exercises encrypted transport, not deployment certificate issuance.
  browser = await chromium.launch({ headless: true })
  const worlds = []
  for (const username of ['alice', 'bob']) {
    const context = await newValidationContext(browser, { ignoreHTTPSErrors: true })
    const page = await context.newPage()
    page.setDefaultTimeout(30_000)
    if (username === 'alice') {
      await page.goto(`${origin}/login?other=1`)
      await page.evaluate(() => localStorage.setItem('dsh-phalanx.appearance.v1', 'dark'))
      await page.reload()
      expect((await context.cookies(origin)).find(cookie => cookie.name === 'dsh-phalanx.appearance.v1')?.value).toBe('dark')
    }
    const resources: string[] = []
    const sockets: string[] = []
    const frames: string[] = []
    const identityRequests: { url: string; method: string }[] = []
    let nativeRequests = false
    page.on('request', request => {
      const url = new URL(request.url())
      if (url.origin === origin && url.pathname === '/account/startup') return
      if (url.origin === origin && url.pathname === '/account/identity' && url.search === '' && request.method() === 'GET') {
        identityRequests.push({ url: request.url(), method: request.method() })
        return
      }
      nativeRequests ||= url.pathname.startsWith('/app/')
      if (nativeRequests) resources.push(request.url())
    })
    page.on('websocket', socket => {
      sockets.push(socket.url())
      socket.on('framesent', frame => frames.push(`sent ${String(frame.payload)}`))
      socket.on('framereceived', frame => frames.push(`received ${String(frame.payload)}`))
    })
    await signInCommunity(page, origin, username, 'password')
    const cookie = await cookieHeader(context, origin)
    const entry = communityEntryUrl(origin, cookie)
    expect(page.url()).toBe(entry)
    try {
      await selectCommunityWorkspace(
        context,
        page,
        origin,
        instanceWorkspacePath(defaultWorkspacePath(root, username), runtime.container !== undefined),
        runtime.container !== undefined,
      )
    } catch (error) {
      throw new Error(`Native TLS workspace admission failed for ${username}`, { cause: error })
    }
    await expect.poll(() => resources.some(url => new URL(url).pathname.includes('/plugins/'))).toBe(true)
    await expect.poll(() => identityRequests.length).toBeGreaterThan(0)
    expect(identityRequests.every(request => request.url === `${origin}/account/identity` && request.method === 'GET')).toBe(true)
    const identity = await context.request.get(`${origin}/account/identity`)
    expect(identity.status()).toBe(200)
    expect(await identity.json()).toEqual({ username, admin: username === adminUsername })
    const cdp = await context.newCDPSession(page)
    const manifest = (await cdp.send('Page.getAppManifest')) as { manifest?: { id?: string; scope?: string; startUrl?: string } }
    expect([manifest.manifest?.id, manifest.manifest?.scope, manifest.manifest?.startUrl]).toEqual([entry, entry, entry])
    expect(sockets.some(url => url.startsWith(entry.replace(/^https/u, 'wss')) && url.endsWith('/api/remote.mux'))).toBe(true)
    await expect.poll(() => frames.some(frame => frame.startsWith('sent ') && frame.includes('"type":"open"'))).toBe(true)
    await expect.poll(() => frames.some(frame => frame.startsWith('received ') && frame.includes('"type":"item"'))).toBe(true)
    expect(resources.filter(url => !url.startsWith(entry))).toEqual([])
    const internal = await page.evaluate(async mount => {
      const initial = location.href
      history.pushState(null, '', `${mount}session/42`)
      try {
        const response = await fetch('api/session/create', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ type: 'client-request', rpcId: 'mounted-relative-session', method: 'session/create', payload: { args: { request: {} } } }),
        })
        return { base: document.baseURI, body: (await response.json()) as { result: { ok: boolean } } }
      } finally {
        history.replaceState(null, '', initial)
      }
    }, new URL(entry).pathname)
    expect(internal.base).toBe(entry)
    expect(internal.body.result.ok).toBe(true)
    const runtimeCookies = (await context.cookies(entry)).filter(row => !row.name.startsWith('dsh-phalanx'))
    expect(runtimeCookies.length).toBeGreaterThan(0)
    expect(runtimeCookies.every(row => row.path === new URL(entry).pathname && row.secure)).toBe(true)
    await runCommunityTerminal(page, "printf 'MOUNT_TERMINAL_%s' OK", 'MOUNT_TERMINAL_OK')
    await page.locator('[data-composer-input]').fill('STREAM_MODEL_TASK')
    await page.locator('[data-composer-input]').press('Enter')
    await page.getByText('COMMUNITY_', { exact: true }).waitFor()
    worlds.push({ context, page, cookie, entry, resources })
  }
  model.release()
  for (const world of worlds) await world.page.locator('p').filter({ hasText: 'COMMUNITY_MODEL_READY' }).last().waitFor()
  const alice = worlds[0]!
  const bob = worlds[1]!
  expect((await alice.context.request.get(bob.entry)).status()).toBe(403)
  const crossed = await new Promise<number>((resolve, reject) => {
    const socket = new WebSocket(`${bob.entry.replace(/^https/u, 'wss')}api/remote.mux`, { rejectUnauthorized: false, headers: { cookie: alice.cookie } })
    socket.once('unexpected-response', (_request, response) => {
      response.resume()
      resolve(response.statusCode!)
    })
    socket.once('open', () => {
      socket.close()
      reject(new Error('Another member WebSocket was admitted'))
    })
    socket.once('error', reject)
  })
  expect(crossed).toBe(403)
  for (const world of worlds) {
    // DSH's documented shell paths and query/hash bookmarks stay within the space.
    const bookmark = `${world.entry}index.html?view=workspace#bookmark`
    await world.page.goto(bookmark)
    await world.page.reload()
    await world.page
      .getByRole('treeitem')
      .filter({ has: world.page.getByText('COMMUNITY_TITLE', { exact: true }) })
      .last()
      .click()
    await world.page.locator('p').filter({ hasText: 'COMMUNITY_MODEL_READY' }).last().waitFor()
    await expect.poll(() => world.page.locator('[data-composer-input]').getAttribute('contenteditable')).toBe('true')
    expect(world.page.url()).toBe(bookmark)
    expect(await createBrowserDshRpc(world.context).remoteRpc(origin, await cookieHeader(world.context, origin), 'session/modelCatalog', {})).toBeTruthy()
    expect(world.resources.filter(url => !url.startsWith(world.entry))).toEqual([])
  }
  const existingSockets = new Set(upgradedConnections)
  const otherTab = await alice.context.newPage()
  await otherTab.goto(alice.entry)
  await otherTab.getByRole('button', { name: 'Platform account: alice', exact: true }).waitFor()
  await expect.poll(() => [...upgradedConnections].filter(socket => !existingSockets.has(socket)).length).toBeGreaterThan(0)
  const oldSockets = [...upgradedConnections].filter(socket => !existingSockets.has(socket))
  // A running model request survives switching away and back in this one browser.
  await alice.page.locator('[data-composer-input]').fill('STREAM_MODEL_TASK')
  await alice.page.locator('[data-composer-input]').press('Enter')
  await alice.page.getByText('COMMUNITY_', { exact: true }).waitFor()
  const acceptedRequests = () => model!.requests.filter(request => latestHumanText(request) === 'STREAM_MODEL_TASK').length
  expect(acceptedRequests()).toBe(3)
  const openSwitcher = async () => {
    await openCommunityAccountMenu(alice.page)
    await alice.page.getByRole('menuitem', { name: 'Switch accounts', exact: true }).click()
    const dialog = alice.page.getByRole('dialog', { name: 'Switch accounts', exact: true })
    await dialog.getByRole('button', { name: 'Add account', exact: true }).waitFor()
    return dialog
  }
  // The shipped SDK dialog follows both native themes without platform colors.
  await alice.page.emulateMedia({ colorScheme: 'light' })
  let dialog = await openSwitcher()
  await dialog.getByText('Current account', { exact: true }).waitFor()
  await expect.poll(() => dialog.evaluate(node => getComputedStyle(node).opacity)).toBe('1')
  const lightColors = await dialog.evaluate(node => [getComputedStyle(node).color, getComputedStyle(node).backgroundColor])
  expect(lightColors[0]).not.toBe(lightColors[1])
  await alice.page.screenshot({ path: join(process.env.DSH_PHALANX_E2E_EVIDENCE_DIR ?? root!, 'account-switch-light.png') })
  await dialog.getByRole('button', { name: 'Close', exact: true }).click()
  await alice.page.emulateMedia({ colorScheme: 'dark' })
  dialog = await openSwitcher()
  await expect.poll(() => dialog.evaluate(node => getComputedStyle(node).opacity)).toBe('1')
  const darkColors = await dialog.evaluate(node => [getComputedStyle(node).color, getComputedStyle(node).backgroundColor])
  expect(darkColors[0]).not.toBe(darkColors[1])
  expect(darkColors).not.toEqual(lightColors)
  await alice.page.screenshot({ path: join(process.env.DSH_PHALANX_E2E_EVIDENCE_DIR ?? root!, 'account-switch-dark.png') })
  await dialog.getByRole('button', { name: 'Add account', exact: true }).click()
  await alice.page.waitForURL(`${origin}/login?other=1`)
  await alice.page.getByLabel('Username', { exact: true }).fill('bob')
  await alice.page.getByLabel('Password', { exact: true }).fill('password')
  await alice.page.getByRole('button', { name: 'Sign in', exact: true }).click({ noWaitAfter: true })
  await alice.page.waitForURL(bob.entry)
  expect(alice.page.url()).toBe(bob.entry)
  await alice.page.getByRole('button', { name: 'Platform account: bob', exact: true }).waitFor()
  await otherTab.getByRole('alertdialog', { name: 'Account changed', exact: true }).waitFor()
  await otherTab.getByText('This browser switched to account bob.', { exact: true }).waitFor()
  await expect.poll(() => oldSockets.filter(socket => !socket.destroyed).length).toBe(0)
  expect((await alice.context.request.get(alice.entry)).status()).toBe(403)
  await otherTab.getByRole('link', { name: 'Go', exact: true }).click()
  await otherTab.waitForURL(bob.entry)
  await otherTab.getByRole('button', { name: 'Platform account: bob', exact: true }).waitFor()
  const current = await (await alice.context.request.get(`${origin}/account/signed-in`)).json()
  expect(current.accounts.find((account: { status: string }) => account.status === 'current').username).toBe('bob')
  dialog = await openSwitcher()
  const switching = alice.page.waitForResponse(response => new URL(response.url()).pathname === '/account/switch' && response.request().method() === 'POST')
  await dialog.getByRole('button', { name: 'alice', exact: true }).click({ noWaitAfter: true })
  const switched = await switching
  expect(switched.status()).toBe(303)
  const switchHeaders = await switched.allHeaders()
  expect(switchHeaders.location).toBe(new URL(alice.entry).pathname)
  expect(switchHeaders['clear-site-data']).toBe('"storage"')
  await alice.page.waitForURL(alice.entry)
  expect((await alice.context.request.get(bob.entry)).status()).toBe(403)
  await otherTab.getByText('This browser switched to account alice.', { exact: true }).waitFor()
  await otherTab.close()
  const workspace = alice.page
    .locator('[role="treeitem"][data-row-key^="workspace:"]')
    .filter({ has: alice.page.getByText('Default workspace', { exact: true }) })
  const titled = alice.page.getByRole('treeitem').filter({ has: alice.page.getByText('COMMUNITY_TITLE', { exact: true }) })
  // Account navigation reloads native expansion state while the session list settles.
  await expect
    .poll(
      async () => {
        if ((await workspace.getAttribute('aria-expanded')) === 'false') await workspace.click()
        return titled.count()
      },
      { timeout: 60_000 },
    )
    .toBeGreaterThan(0)
  await titled.last().click({ timeout: 60_000 })
  await alice.page.getByText('COMMUNITY_', { exact: true }).waitFor()
  model.release()
  await expect.poll(() => alice.page.locator('p').filter({ hasText: 'COMMUNITY_MODEL_READY' }).count()).toBe(2)
  expect(acceptedRequests()).toBe(3)
  expect(await createBrowserDshRpc(alice.context).remoteRpc(origin, await cookieHeader(alice.context, origin), 'session/modelCatalog', {})).toBeTruthy()

  // A member adds their administrator login through the native dialog, then switches back from management.
  dialog = await openSwitcher()
  await dialog.getByRole('button', { name: 'Add account', exact: true }).click()
  await alice.page.waitForURL(`${origin}/login?other=1`)
  await alice.page.getByLabel('Username', { exact: true }).fill(adminUsername)
  await alice.page.getByLabel('Password', { exact: true }).fill('password')
  await alice.page.getByRole('button', { name: 'Sign in', exact: true }).click({ noWaitAfter: true })
  await alice.page.waitForURL(`${origin}/admin`)
  await alice.page.locator('#admin-sidebar').getByRole('button', { name: 'Switch accounts', exact: true }).click()
  expect(await alice.page.locator('html').getAttribute('data-theme')).toBe('dark')
  expect(await alice.page.locator('html').getAttribute('data-appearance')).toBe('dark')
  const managementDialog = alice.page.getByRole('dialog', { name: 'Switch accounts', exact: true })
  await managementDialog.getByRole('listitem').filter({ hasText: adminUsername }).getByText('Current account', { exact: true }).waitFor()
  await managementDialog.getByRole('button', { name: 'alice', exact: true }).click({ noWaitAfter: true })
  await alice.page.waitForURL(alice.entry)
  await alice.page.getByRole('button', { name: 'Platform account: alice', exact: true }).waitFor()
  expect(await createBrowserDshRpc(alice.context).remoteRpc(origin, await cookieHeader(alice.context, origin), 'session/modelCatalog', {})).toBeTruthy()

  await app.stop()
  app = candidateApplication(config)
  await app.start()
  for (const world of worlds) {
    await signInCommunity(world.page, origin, world === alice ? 'alice' : 'bob', 'password')
    expect(world.page.url()).toBe(world.entry)
    await world.page
      .getByRole('treeitem')
      .filter({ has: world.page.getByText('COMMUNITY_TITLE', { exact: true }) })
      .last()
      .click()
    await world.page.locator('p').filter({ hasText: 'COMMUNITY_MODEL_READY' }).last().waitFor()
    expect(await createBrowserDshRpc(world.context).remoteRpc(origin, await cookieHeader(world.context, origin), 'session/modelCatalog', {})).toBeTruthy()
  }
  dialog = await openSwitcher()
  const bobRow = dialog.getByRole('listitem').filter({ hasText: 'bob' })
  await bobRow.getByRole('button', { name: 'More actions', exact: true }).click()
  await alice.page.getByRole('menuitem', { name: 'Remove', exact: true }).click()
  await expect.poll(() => dialog.getByRole('listitem').filter({ hasText: 'bob' }).count()).toBe(0)
  expect(alice.page.url()).toBe(alice.entry)
  await dialog.getByRole('button', { name: 'Close', exact: true }).click()
  await signInCommunity(alice.page, origin, 'bob', 'password')
  await alice.page.getByRole('button', { name: 'Platform account: bob', exact: true }).waitFor()
  dialog = await openSwitcher()
  await dialog.getByRole('button', { name: 'alice', exact: true }).click({ noWaitAfter: true })
  await alice.page.waitForURL(alice.entry)
  await alice.page.getByRole('button', { name: 'Platform account: alice', exact: true }).waitFor()
  const admin = await browser.newContext({ ignoreHTTPSErrors: true })
  expect(
    (await admin.request.post(`${origin}/login`, { headers: { origin }, form: { username: adminUsername, password: 'password' }, maxRedirects: 0 })).status(),
  ).toBe(303)
  expect(
    (
      await admin.request.post(`${origin}/admin/api/accounts/bob/actions`, {
        headers: { origin },
        data: { action: 'reset-password', password: 'changed-password' },
      })
    ).status(),
  ).toBe(200)
  dialog = await openSwitcher()
  const rememberedBob = dialog.getByRole('listitem').filter({ hasText: 'bob' })
  await rememberedBob.getByText('Sign in again', { exact: true }).waitFor()
  const desktopViewport = alice.page.viewportSize()!
  await alice.page.setViewportSize({ width: 390, height: 844 })
  await dialog.getByRole('button', { name: adminUsername, exact: true }).waitFor()
  const actionButtons = dialog.getByRole('button', { name: 'More actions', exact: true })
  await expect.poll(() => actionButtons.count()).toBeGreaterThan(1)
  const actionPositions = await actionButtons.evaluateAll(buttons => buttons.map(button => button.getBoundingClientRect().right))
  expect(new Set(actionPositions).size).toBe(1)
  expect(await dialog.evaluate(node => node.scrollWidth)).toBe(await dialog.evaluate(node => node.clientWidth))
  await dialog.screenshot({ path: join(process.env.DSH_PHALANX_E2E_EVIDENCE_DIR ?? root!, 'account-switch-narrow.png'), animations: 'disabled' })
  await alice.page.setViewportSize(desktopViewport)
  await rememberedBob.getByRole('button', { name: 'bob', exact: true }).click()
  await alice.page.waitForURL(`${origin}/login?username=bob`)
  expect(await alice.page.getByLabel('Username', { exact: true }).inputValue()).toBe('bob')
  await alice.page.getByLabel('Password', { exact: true }).fill('changed-password')
  await alice.page.getByRole('button', { name: 'Sign in', exact: true }).click({ noWaitAfter: true })
  await alice.page.waitForURL(bob.entry)
  await alice.page.getByRole('button', { name: 'Platform account: bob', exact: true }).waitFor()
  dialog = await openSwitcher()
  await dialog.getByRole('button', { name: 'alice', exact: true }).click({ noWaitAfter: true })
  await alice.page.waitForURL(alice.entry)
  await alice.page.getByRole('button', { name: 'Platform account: alice', exact: true }).waitFor()
  expect(
    (await admin.request.post(`${origin}/admin/api/accounts/bob/actions`, { headers: { origin }, data: { action: 'set-disabled', disabled: true } })).status(),
  ).toBe(200)
  dialog = await openSwitcher()
  const unavailableBob = dialog.getByRole('listitem').filter({ hasText: 'bob' })
  await unavailableBob.getByText('Unavailable', { exact: true }).waitFor()
  expect(await unavailableBob.getByRole('button', { name: 'bob', exact: true }).isEnabled()).toBe(false)
  expect(await unavailableBob.getByRole('button', { name: 'More actions', exact: true }).count()).toBe(0)
  await unavailableBob.getByRole('button', { name: 'Remove', exact: true }).click()
  await expect.poll(() => dialog.getByRole('listitem').filter({ hasText: 'bob' }).count()).toBe(0)
  await admin.close()
  await dialog.getByRole('button', { name: 'Sign out of all accounts', exact: true }).click({ noWaitAfter: true })
  await alice.page.waitForURL(`${origin}/login`)
  await alice.page.getByRole('heading', { name: 'Sign in to dsh-phalanx', exact: true }).waitFor()
}, 600_000)
