// Validation: T2; real credentials: none; controlled browser/process fixtures. CI selects its explicit public-entry subset.
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium, type Browser, type CDPSession } from 'playwright'
import { afterEach, expect, it } from 'vitest'
import { loopbackPort } from '../src/adapters/loopback-port.js'
import { issueBootstrapCredential, readBootstrapCredential } from '../src/adapters/bootstrap-credential.js'
import type { CommunityApplication } from '../src/ports/community-application.js'
import { cleanupOwned, removeCommunityFixture } from './fixtures/owned-cleanup.js'
import { createCommunityApplication } from './support/community-application.js'
import { selectBuiltinDatabase } from './support/community-bootstrap-browser.js'
let app: CommunityApplication | undefined, browser: Browser | undefined, root: string | undefined, navigationSource: Server | undefined

afterEach(async () => {
  await browser?.close()
  if (navigationSource) {
    navigationSource.closeAllConnections()
    await new Promise<void>(resolve => navigationSource!.close(() => resolve()))
    navigationSource = undefined
  }
  await app?.stop()
  if (root) await removeCommunityFixture(root)
})
it('allows external bootstrap document links while rejecting cross-origin actions and subresources', async () => {
  root = await mkdtemp(join(tmpdir(), 'bootstrap-navigation-'))
  const port = await loopbackPort()
  const origin = `http://app.example.localhost:${port}`
  app = createCommunityApplication({
    listen: { host: '127.0.0.1', port, publicOrigin: origin },
    sessionSecret: 'bootstrap-navigation-session-secret-32bytes',
    runtime: {
      command: '/unavailable-dsh',
      args: [],
      dataRoot: root,
      defaultModel: { provider: 'deepseek-official', model: 'fixture', upstream: { baseUrl: 'https://api.deepseek.com' } },
    },
  })
  await app.start()
  browser = await chromium.launch({ headless: true, args: ['--proxy-server=direct://', '--host-resolver-rules=MAP *.localhost 127.0.0.1'] })
  const context = await browser.newContext({ locale: 'en' })
  const page = await context.newPage()
  navigationSource = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html' })
    response.end(`<a href="${origin}/bootstrap">Initialize</a>`)
  })
  await new Promise<void>(resolve => navigationSource!.listen(0, '127.0.0.1', resolve))
  const sourcePort = (navigationSource.address() as { port: number }).port
  for (const [source, site] of [
    [`http://outside.localhost:${sourcePort}`, 'cross-site'],
    [`http://other.example.localhost:${sourcePort}`, 'same-site'],
  ] as const) {
    await page.goto(source)
    const navigation = page.waitForResponse(response => response.url() === origin + '/bootstrap' && response.request().isNavigationRequest())
    await page.getByRole('link', { name: 'Initialize', exact: true }).click()
    const opened = await navigation
    expect(opened.status()).toBe(200)
    expect((await opened.request().allHeaders())['sec-fetch-site']).toBe(site)
    await page.getByRole('heading', { name: 'Create the first administrator', exact: true }).waitFor()
    expect(await page.getByRole('button', { name: 'Create administrator', exact: true }).count()).toBe(0)
    await page.goto(source)
    const deniedFrame = page.waitForResponse(response => response.url() === origin + '/bootstrap')
    await page.evaluate(url => {
      const frame = document.createElement('iframe')
      frame.src = url
      document.body.appendChild(frame)
    }, origin + '/bootstrap')
    expect((await deniedFrame).status()).toBe(403)
    const deniedFetch = page.waitForResponse(response => response.url() === origin + '/bootstrap' && response.request().resourceType() === 'fetch')
    await page.evaluate(url => {
      void fetch(url, { mode: 'no-cors' })
    }, origin + '/bootstrap')
    expect((await deniedFetch).status()).toBe(403)
    const postNavigation = page.waitForURL(origin + '/bootstrap')
    const deniedPost = page.waitForResponse(response => response.url() === origin + '/bootstrap' && response.request().method() === 'POST')
    await page.evaluate(url => {
      const form = document.createElement('form')
      form.action = url
      form.method = 'post'
      document.body.appendChild(form)
      form.submit()
    }, origin + '/bootstrap')
    expect((await deniedPost).status()).toBe(403)
    await postNavigation
  }
})

it('keeps themed entry and complete error pages independent of management assets', async () => {
  root = await mkdtemp(join(tmpdir(), 'community-page-browser-'))
  app = createCommunityApplication({
    listen: { host: '127.0.0.1', port: 0 },
    sessionSecret: 'pages-fixture-session-secret-at-least-32-bytes',
    runtime: {
      command: '/unavailable-dsh',
      args: [],
      dataRoot: root,
      defaultModel: { provider: 'deepseek-official', model: 'fixture', upstream: { baseUrl: 'https://api.deepseek.com' } },
    },
  })
  const origin = await app.start()
  browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({ locale: 'en', colorScheme: 'dark', viewport: { width: 390, height: 844 } })
  const page = await context.newPage()
  const adminAssets: string[] = []
  page.on('request', request => {
    if (request.url().includes('/admin/assets/')) adminAssets.push(request.url())
  })
  await context.route('**/admin/assets/**', route => route.abort())
  await page.goto(`${origin}/bootstrap`)
  expect(await page.locator('html').getAttribute('data-theme')).toBe('dark')
  expect(await page.getByRole('button', { name: 'Create administrator', exact: true }).isVisible()).toBe(false)
  await page.goto(`${origin}/bootstrap#credential=invalid`)
  await page.getByText('This initialization link is invalid.', { exact: false }).waitFor()
  const expired = issueBootstrapCredential(root, 0)
  const rejected = await context.request.post(`${origin}/bootstrap`, {
    form: { credential: expired.credential, username: 'admin', password: 'private-submitted-password' },
    headers: { origin },
    maxRedirects: 0,
  })
  expect(rejected.status()).toBe(403)
  expect(rejected.headers()['content-type']).toContain('text/html')
  expect(await rejected.text()).not.toContain(expired.credential)
  expect(await rejected.text()).not.toContain('private-submitted-password')
  await page.goto(`${origin}/bootstrap#credential=${expired.credential}`)
  await page.getByRole('alert').filter({ hasText: 'Invalid or expired' }).waitFor()
  expect(await page.getByLabel('Username', { exact: true }).count()).toBe(0)
  expect(await page.getByLabel('Password', { exact: true }).count()).toBe(0)
  expect(await page.locator('[name="databaseHost"]').count()).toBe(0)
  expect(adminAssets).toHaveLength(0)
  const valid = issueBootstrapCredential(root)
  expect(
    (
      await context.request.post(`${origin}/bootstrap`, {
        headers: { origin },
        form: { credential: valid.credential, username: 'admin', password: 'password' },
        maxRedirects: 0,
      })
    ).status(),
  ).toBe(303)
  expect(readBootstrapCredential(root)).toBeUndefined()
  const closed = await page.goto(`${origin}/bootstrap`)
  expect(closed!.status()).toBe(404)
  await page.getByRole('heading', { name: 'Initialization unavailable', exact: true }).waitFor()
  expect(await page.getByRole('button', { name: 'Create administrator', exact: true }).count()).toBe(0)
  await page.getByRole('link', { name: 'Sign in', exact: true }).click()
  await page.getByRole('link', { name: 'Use another account', exact: true }).click()
  await page.getByRole('button', { name: 'Light', exact: true }).click()
  await page.getByLabel('Username', { exact: true }).fill('admin')
  await page.getByLabel('Password', { exact: true }).fill('wrong-private-password')
  const denied = page.waitForResponse(response => new URL(response.url()).pathname === '/login' && response.request().method() === 'POST')
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  expect((await denied).status()).toBe(401)
  await page.getByRole('alert').waitFor()
  expect(await page.getByLabel('Password', { exact: true }).inputValue()).toBe('')
  expect(await page.content()).not.toContain('wrong-private-password')
  expect(await page.locator('html').getAttribute('data-theme')).toBe('light')
  await page.getByLabel('Username', { exact: true }).fill('admin')
  await page.getByLabel('Password', { exact: true }).fill('password')
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await page.waitForURL(`${origin}/admin`)
  expect(
    (
      await context.request.post(`${origin}/admin/api/accounts`, {
        headers: { origin },
        data: { username: 'member', email: 'member@example.test', password: 'password' },
      })
    ).status(),
  ).toBe(201)
  let attemptedAdminAssets = adminAssets.length
  expect(
    (await context.request.post(`${origin}/login`, { headers: { origin }, form: { username: 'member', password: 'password' }, maxRedirects: 0 })).status(),
  ).toBe(303)
  expect((await context.request.get(`${origin}/admin/api/session`)).status()).toBe(403)
  await page.goto(`${origin}/recovery?restart=1`)
  await page.getByRole('heading', { name: 'Instance recovery', exact: true }).waitFor()
  expect(await page.locator('html').getAttribute('data-theme')).toBe('light')
  const restartTab = page.getByRole('tab', { name: 'Restart instance', exact: true })
  const resetTab = page.getByRole('tab', { name: 'Reset DSH environment', exact: true })
  const resetHeading = page.getByRole('heading', { name: 'Reset DSH environment', exact: true })
  await resetHeading.waitFor({ state: 'hidden' })
  expect(await restartTab.getAttribute('aria-selected')).toBe('true')
  await restartTab.focus()
  await restartTab.press('ArrowRight')
  await resetHeading.waitFor()
  expect(await resetTab.getAttribute('aria-selected')).toBe('true')
  expect(page.url()).toBe(`${origin}/recovery`)
  await restartTab.click()
  await resetHeading.waitFor({ state: 'hidden' })
  expect(page.url()).toBe(`${origin}/recovery?restart=1`)
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.screenshot({ path: join(process.env.DSH_PHALANX_E2E_EVIDENCE_DIR ?? root!, 'phalanx-recovery-light-desktop.png') })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.locator('#restart').getByRole('checkbox').check()
  await page.getByRole('button', { name: 'Restart instance', exact: true }).click()
  await page.getByRole('status').filter({ hasText: 'Restart failed.' }).waitFor()
  expect(await page.getByRole('button', { name: 'Restart instance', exact: true }).isEnabled()).toBe(true)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  // The remembered-account list is server-rendered even while this DSH cannot start.
  await page.locator('#signed-in-accounts > summary').click()
  const choices = page.getByRole('list', { name: 'Switch accounts', exact: true })
  await choices.getByText('Current account', { exact: true }).waitFor()
  expect(adminAssets).toHaveLength(attemptedAdminAssets)
  expect(await page.locator('script[src]').count()).toBe(0)
  const switched = page.waitForResponse(response => new URL(response.url()).pathname === '/account/switch' && response.request().method() === 'POST')
  await choices.getByRole('button', { name: /^admin/u }).click({ noWaitAfter: true })
  expect((await switched).status()).toBe(303)
  await page.waitForURL(`${origin}/admin`)
  expect((await (await context.request.get(`${origin}/admin/api/session`)).json()).username).toBe('admin')
  attemptedAdminAssets = adminAssets.length
  await page.goto(`${origin}/login`)
  await page.getByRole('button', { name: 'member', exact: true }).click({ noWaitAfter: true })
  await page.waitForURL(url => /^\/app\/[a-f0-9]{32}\/$/u.test(url.pathname))
  await page.locator('#failure').waitFor({ state: 'visible' })
  await page.goto(`${origin}/recovery?restart=1`)
  await page.getByRole('heading', { name: 'Instance recovery', exact: true }).waitFor()
  await page.getByRole('button', { name: 'Light', exact: true }).click()
  await page.locator('#signed-in-accounts > summary').click()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.screenshot({ path: join(process.env.DSH_PHALANX_E2E_EVIDENCE_DIR ?? root!, 'phalanx-recovery-light-mobile.png'), fullPage: true })
  await page.getByRole('button', { name: 'Log out', exact: true }).click()
  await page.waitForURL(`${origin}/login`)
  expect(adminAssets.length).toBeGreaterThan(0)
  expect(adminAssets).toHaveLength(attemptedAdminAssets)
  // Only the deliberately attempted management navigations requested their bundle.
  expect(await page.locator('script[src]').count()).toBe(0)
})

it('keeps bilingual narrow startup failures on the bookmarked address and enters only after a confirmed retry', async () => {
  const { createServer } = await import('node:http')
  const { CommunityInstanceLifecycle } = await import('../src/use-cases/community-instance-lifecycle.js')
  const nativeMethods: string[] = []
  const target = createServer((request, response) => {
    nativeMethods.push(request.method ?? 'GET')
    if (request.url === '/launch') {
      response.writeHead(303, { location: '/', 'set-cookie': 'native_fixture=ready; Path=/; HttpOnly' })
      response.end()
      return
    }
    if (!(request.headers.cookie ?? '').includes('native_fixture=ready')) {
      response.writeHead(401)
      response.end()
      return
    }
    response.setHeader('content-type', 'text/html')
    response.end('<div id="root">NATIVE_WORKSPACE_READY</div>')
  })
  await new Promise<void>(resolve => {
    target.listen(0, '127.0.0.1', resolve)
  })
  const address = target.address()
  if (!address || typeof address === 'string') throw Error('No browser fixture listener')
  const targetOrigin = `http://127.0.0.1:${address.port}`
  let release: () => void = () => {}
  try {
    browser = await chromium.launch({ headless: true })
    for (const locale of ['en', 'zh-CN'] as const) {
      root = await mkdtemp(join(tmpdir(), 'startup-page-browser-'))
      let generation = 0,
        complete!: () => void
      let gate = new Promise<void>(resolve => {
        complete = resolve
      })
      release = () => {
        complete()
      }
      const runtime = new CommunityInstanceLifecycle(
        {
          rebuild: async () => [],
          alive: async () => true,
          stop: async () => {},
          detach: async () => {},
          start: async userId => {
            const current = ++generation
            await gate
            if (current === 1) throw Error('PRIVATE_HOST_CREDENTIAL')
            return { userId, processId: current, origin: targetOrigin, launchUrl: targetOrigin + '/launch' }
          },
        },
        async () => ({ url: targetOrigin, token: 'fictional' }),
      )
      app = createCommunityApplication(
        {
          listen: { host: '127.0.0.1', port: 0 },
          sessionSecret: 'startup-browser-fixture-secret-at-least-32-bytes',
          idleReclaimSeconds: 0,
          runtime: {
            command: '/unused',
            args: [],
            dataRoot: root,
            defaultModel: { provider: 'deepseek-official', model: 'fixture', upstream: { baseUrl: targetOrigin } },
          },
        },
        { runtime },
      )
      const origin = await app.start(),
        context = await browser.newContext({ locale, colorScheme: 'dark', viewport: { width: 320, height: 700 } }),
        page = await context.newPage()
      const bootstrap = await context.request.post(origin + '/bootstrap', {
        headers: { origin },
        form: { credential: readBootstrapCredential(root)!.credential, username: 'admin', password: 'password' },
        maxRedirects: 0,
      })
      expect(bootstrap.status()).toBe(303)
      expect(
        (
          await context.request.post(origin + '/admin/api/accounts', { headers: { origin }, data: { username: 'member', email: '', password: 'password' } })
        ).status(),
      ).toBe(201)
      await page.goto(origin + '/login?other=1')
      await page.getByLabel(locale === 'en' ? 'Username' : '用户名', { exact: true }).fill('member')
      await page.getByLabel(locale === 'en' ? 'Password' : '密码', { exact: true }).fill('password')
      const login = page.waitForResponse(response => new URL(response.url()).pathname === '/login' && response.request().method() === 'POST')
      await page.getByRole('button', { name: locale === 'en' ? 'Sign in' : '登录', exact: true }).click({ noWaitAfter: true })
      expect((await login).status()).toBe(303)
      await page.locator('[data-platform-startup]').waitFor()
      const bookmark = page.url() + '?view=saved#position'
      await page.goto(bookmark)
      await page.locator('[data-platform-startup]').waitFor()
      const posted = page.waitForResponse(response => response.request().isNavigationRequest() && response.request().method() === 'POST')
      await page.evaluate(url => {
        const form = document.createElement('form')
        form.method = 'POST'
        form.action = url
        document.body.append(form)
        form.submit()
      }, bookmark)
      expect((await posted).status()).toBe(200)
      await page.waitForLoadState('domcontentloaded')
      await page.locator('[data-platform-startup]').waitFor()
      expect(await page.locator('html').getAttribute('data-theme')).toBe('dark')
      expect(await page.locator('script[src],link[rel=stylesheet],#root').count()).toBe(0)
      expect(await page.locator('#stage').textContent()).toBe(locale === 'en' ? 'Preparing plugins and skills' : '准备插件与技能')
      await page.clock.install()
      await page.clock.fastForward(15_001)
      await page.locator('#slow').waitFor({ state: 'visible' })
      complete()
      await page.clock.fastForward(1001)
      await page.locator('#failure').waitFor({ state: 'visible' })
      expect(await page.content()).not.toContain('PRIVATE_HOST_CREDENTIAL')
      let phaseRequests = 0,
        navigations = 0
      page.on('request', request => {
        if (new URL(request.url()).pathname === '/account/startup') phaseRequests++
        if (request.isNavigationRequest()) navigations++
      })
      await page.clock.fastForward(60_000)
      expect(phaseRequests).toBe(0)
      expect(navigations).toBe(0)
      expect(page.url()).toBe(bookmark)
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      expect(await page.getByRole('link', { name: locale === 'en' ? 'More recovery options' : '更多恢复选项', exact: true }).getAttribute('href')).toBe(
        '/recovery',
      )
      gate = new Promise<void>(resolve => {
        complete = resolve
      })
      await page.locator('#restart').getByRole('checkbox').check()
      await page.getByRole('button', { name: locale === 'en' ? 'Restart instance' : '重启实例', exact: true }).click({ noWaitAfter: true })
      await expect.poll(() => generation).toBe(2)
      complete()
      await page.locator('#root').waitFor({ state: 'attached' })
      expect(page.url()).toBe(bookmark)
      expect(await page.locator('#root').textContent()).toBe('NATIVE_WORKSPACE_READY')
      expect(generation).toBe(2)
      expect(nativeMethods).not.toContain('POST')
      await context.close()
      await app.stop()
      app = undefined
      await rm(root, { recursive: true, force: true })
      root = undefined
    }
  } finally {
    release()
    target.closeAllConnections()
    await new Promise<void>((resolve, reject) => {
      target.close(error => (error ? reject(error) : resolve()))
    })
  }
})

it('keeps confirmed self reset and translated cooldown available without management assets', async () => {
  const { fileURLToPath } = await import('node:url')
  root = await mkdtemp(join(tmpdir(), 'self-reset-page-'))
  app = createCommunityApplication({
    listen: { host: '127.0.0.1', port: 0 },
    sessionSecret: 'self-reset-page-fixture-secret-at-least-32-bytes',
    runtime: {
      command: process.execPath,
      args: [fileURLToPath(new URL('./fixtures/runtime.mjs', import.meta.url))],
      dataRoot: root,
      defaultModel: { provider: 'deepseek-official', model: 'fixture', upstream: { baseUrl: 'http://127.0.0.1:1' } },
    },
  })
  const origin = await app.start()
  browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({ locale: 'en', viewport: { width: 390, height: 844 } }),
    page = await context.newPage()
  page.setDefaultTimeout(10000)
  await page.goto(`${origin}/bootstrap#credential=${readBootstrapCredential(root)!.credential}`)
  await selectBuiltinDatabase(page)
  await page.getByLabel('Username', { exact: true }).fill('admin')
  await page.getByLabel('Password', { exact: true }).fill('password')
  await page.getByRole('button', { name: 'Create administrator', exact: true }).click()
  await page.getByRole('button', { name: /^(Skip for now and finish installation|暂时跳过，完成安装)$/u }).click()
  await page.waitForURL(`${origin}/admin`)
  expect(
    (
      await context.request.post(origin + '/admin/api/accounts', { headers: { origin }, data: { username: 'alice', email: '', password: 'password' } })
    ).status(),
  ).toBe(201)
  const member = await browser.newContext({ locale: 'en', viewport: { width: 390, height: 844 } }),
    recovery = await member.newPage()
  recovery.setDefaultTimeout(10000)
  expect(
    (await member.request.post(origin + '/login', { headers: { origin }, form: { username: 'alice', password: 'password' }, maxRedirects: 0 })).status(),
  ).toBe(303)
  await recovery.route('**/admin/assets/**', route => route.abort())
  await recovery.goto(origin + '/recovery')
  await recovery.getByRole('heading', { name: 'Reset DSH environment', exact: true }).waitFor()
  expect(await recovery.getByRole('tab', { name: 'Reset DSH environment', exact: true }).getAttribute('aria-selected')).toBe('true')
  const form = recovery.locator('#reset-environment')
  await form.getByRole('button', { name: 'Reset environment', exact: true }).click()
  expect(await recovery.locator('#reset-status').textContent()).toBe('')
  await form.getByRole('checkbox').check()
  const completed = recovery.waitForResponse(response => new URL(response.url()).pathname === '/recovery/reset')
  await form.getByRole('button', { name: 'Reset environment', exact: true }).click()
  expect((await completed).status()).toBe(200)
  await recovery.locator('#reset-status').filter({ hasText: 'DSH environment reset.' }).waitFor()
  expect(await recovery.getByRole('link', { name: 'Return to DSH', exact: true }).getAttribute('href')).toMatch(/^\/app\/[a-f0-9]{32}\/$/u)
  expect(await recovery.locator('script[src]').count()).toBe(0)
  await page.goto(origin + '/admin/accounts')
  await page.getByRole('button', { name: 'Edit alice', exact: true }).click()
  const details = page.getByRole('dialog', { name: 'Edit account: alice', exact: true })
  await details.getByText('Last environment reset requested', { exact: true }).waitFor()
  await details.getByText(/^Requested by member alice at /u).waitFor()
  await recovery.getByRole('toolbar', { name: 'Appearance', exact: true }).waitFor()
  await recovery.locator('.entry-language > summary').click()
  await recovery.getByRole('menuitemradio', { name: '简体中文', exact: true }).click()
  await recovery.getByRole('heading', { name: '重置 DSH 环境', exact: true }).waitFor()
  await form.getByRole('checkbox').check()
  await form.getByRole('button', { name: '重置环境', exact: true }).click()
  await expect.poll(() => recovery.locator('#reset-status').textContent()).toMatch(/请等待 \d+ 秒/u)
  expect(await recovery.locator('#reset-status').textContent()).not.toContain('{seconds}')
  expect(await recovery.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await recovery.screenshot({ path: join(process.env.DSH_PHALANX_E2E_EVIDENCE_DIR ?? root!, 'member-reset-chinese-mobile.png'), fullPage: true })
})

it('keeps the bilingual maintenance page independent and refreshes only after a ready response', async () => {
  root = await mkdtemp(join(tmpdir(), 'maintenance-page-browser-'))
  const marker = join(root, 'maintenance')
  app = createCommunityApplication({
    listen: { host: '127.0.0.1', port: 0 },
    sessionSecret: 'maintenance-fixture-session-secret-at-least-32-bytes',
    maintenanceFile: marker,
    runtime: {
      command: '/unavailable-dsh',
      args: [],
      dataRoot: join(root, 'data'),
      defaultModel: { provider: 'deepseek-official', model: 'fixture', upstream: { baseUrl: 'https://api.deepseek.com' } },
    },
  })
  const origin = await app.start()
  browser = await chromium.launch({ headless: true })
  for (const [locale, rate] of [
    ['en', 1],
    ['zh-CN', 1],
    ['en', 4],
    ['zh-CN', 4],
  ] as const) {
    await writeFile(marker, 'Upgrade validation\n')
    const context = await browser.newContext({ locale, colorScheme: 'dark', viewport: { width: 390, height: 844 } })
    let cdp: CDPSession | undefined
    const failures: unknown[] = []
    let releaseReady!: () => void, sawReady!: () => void
    const readyRequested = new Promise<void>(resolve => {
        sawReady = resolve
      }),
      readiness = new Promise<void>(resolve => {
        releaseReady = resolve
      })
    try {
      await context.addCookies([{ name: 'dsh-phalanx.lang', value: 'en', url: origin }])
      await context.route(origin + '/readyz', async route => {
        sawReady()
        await readiness
        await route.continue()
      })
      const page = await context.newPage(),
        assets: string[] = []
      cdp = await context.newCDPSession(page)
      await cdp.send('Emulation.setCPUThrottlingRate', { rate })
      page.on('request', request => {
        if (request.url().includes('/admin/assets/')) assets.push(request.url())
      })
      const response = await page.goto(origin + '/login?other=1')
      expect(response!.status()).toBe(503)
      expect(response!.headers()['retry-after']).toBe('3')
      await page
        .getByRole('status')
        .filter({ hasText: locale === 'en' ? 'System upgrade in progress' : '系统升级中' })
        .waitFor()
      expect(await page.locator('html').getAttribute('lang')).toBe(locale)
      expect(await page.locator('html').getAttribute('data-theme')).toBe('dark')
      expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe('rgb(21, 21, 23)')
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      expect(assets).toEqual([])
      await readyRequested
      await page.screenshot({
        path: join(process.env.DSH_PHALANX_E2E_EVIDENCE_DIR ?? root!, `phalanx-maintenance-${locale}-dark-mobile${rate === 1 ? '' : '-cpu4'}.png`),
        fullPage: true,
      })
      expect(await page.locator('[data-platform-maintenance]').count()).toBe(1)
      const reloaded = page.waitForEvent('load')
      await rm(marker)
      releaseReady()
      await reloaded
      await page.getByLabel('Username', { exact: true }).waitFor()
      expect(await page.locator('[data-platform-maintenance]').count()).toBe(0)
      expect(assets).toEqual([])
    } catch (error) {
      failures.push(error)
    }
    releaseReady()
    try {
      await cleanupOwned(
        async () => cdp?.send('Emulation.setCPUThrottlingRate', { rate: 1 }),
        async () => cdp?.detach(),
        async () => context.close(),
      )
    } catch (error) {
      failures.push(error)
    }
    if (failures.length) throw new AggregateError(failures, 'Maintenance browser acceptance failed')
  }
})

it('configures one initial default for all three protocols without exposing preset keys and recovers committed publication by revision', async () => {
  browser = await chromium.launch({ headless: true })
  for (const protocol of ['openai-completions', 'openai-responses', 'anthropic-messages'] as const) {
    root = await mkdtemp(join(tmpdir(), 'initial-model-entry-'))
    const defaults = join(root, 'initial-model.json')
    const contents = JSON.stringify({ name: 'Suggested provider', apiKey: 'fictional-initial-preset-key' })
    await writeFile(defaults, contents, { mode: 0o600 })
    app = createCommunityApplication({
      initialModelDefaultsFile: defaults,
      listen: { host: '127.0.0.1', port: 0 },
      runtime: {
        command: '/unavailable-dsh',
        args: [],
        dataRoot: root,
        defaultModel: { provider: 'deepseek-official', model: 'fixture', upstream: { baseUrl: 'http://127.0.0.1:1' } },
      },
    })
    const origin = await app.start(),
      context = await browser.newContext({ locale: 'en', viewport: { width: 390, height: 844 } }),
      page = await context.newPage()
    await page.goto(origin + '/bootstrap#credential=' + readBootstrapCredential(root)!.credential)
    await selectBuiltinDatabase(page)
    await page.getByLabel('Username', { exact: true }).fill('admin')
    await page.getByLabel('Password', { exact: true }).fill('password')
    await page.getByRole('button', { name: 'Create administrator', exact: true }).click()
    await page.waitForURL(origin + '/admin/initial-model')
    const anonymous = await browser.newContext()
    expect((await anonymous.request.get(origin + '/admin/api/initial-model')).status()).toBe(401)
    await anonymous.close()
    await page.getByRole('heading', { name: 'Configure your first model', exact: true }).waitFor()
    expect(readBootstrapCredential(root)).toBeUndefined()
    expect(await page.getByLabel('Provider name', { exact: true }).inputValue()).toBe('Suggested provider')
    expect(await page.getByLabel('API key', { exact: true }).inputValue()).toBe('')
    expect(await page.content()).not.toContain('fictional-initial-preset-key')
    expect(await (await context.request.get(origin + '/admin/api/initial-model')).text()).not.toContain('fictional-initial-preset-key')
    expect(
      (await context.request.post(origin + '/admin/api/initial-model', { headers: { origin: 'https://other.example.test' }, data: { revision: 0 } })).status(),
    ).toBe(403)
    await page.getByLabel('Protocol', { exact: true }).selectOption(protocol)
    await page.locator('[name="baseUrl"]').fill('https://models.example.test/v1')
    await page.getByLabel('Model identifier 1', { exact: true }).fill('first-model')
    if (protocol === 'openai-responses') await page.getByLabel('API key', { exact: true }).fill('fictional-replaced-new')
    const catalog = join(root, 'managed-models/catalog.json')
    if (protocol === 'openai-completions') {
      await rm(catalog)
      await mkdir(catalog)
    }
    await page.getByRole('button', { name: 'Save model configuration and finish installation', exact: true }).click()
    if (protocol === 'openai-completions') {
      await page.getByRole('button', { name: 'Retry model publication', exact: true }).waitFor()
      await page.reload()
      const committed = await (await context.request.get(origin + '/admin/api/models')).json()
      expect(committed.revision).toBe(1)
      expect(committed.providers).toHaveLength(1)
      await rm(catalog, { recursive: true })
      await page.getByRole('button', { name: 'Retry model publication', exact: true }).click()
    }
    await page.getByRole('status').filter({ hasText: 'Configuration saved. The model has not been tested.' }).waitFor()
    const saved = await (await context.request.get(origin + '/admin/api/models')).json()
    expect(saved.revision).toBe(1)
    expect(saved.providers).toHaveLength(1)
    expect(saved.providers[0].apiFormat).toBe(protocol)
    expect(saved.providers[0].apiKey.last4).toBe(protocol === 'openai-responses' ? '-new' : '-key')
    expect(saved.providers[0].enabled).toBe(true)
    expect(saved.providers[0].models).toHaveLength(1)
    expect(saved.providers[0].models[0]).toMatchObject({ name: 'first-model', enabled: true })
    expect(saved.defaultModelId).toBe(saved.providers[0].models[0].id)
    expect(JSON.stringify(saved)).not.toContain('fictional-initial-preset-key')
    expect(JSON.stringify(saved)).not.toContain('fictional-replaced-new')
    const duplicate = await context.request.post(origin + '/admin/api/initial-model', { headers: { origin }, data: { revision: 0 } })
    expect(duplicate.status()).toBe(200)
    expect(await duplicate.json()).toEqual(saved)
    expect(await readFile(defaults, 'utf8')).toBe(contents)
    await page.getByRole('button', { name: 'Continue to administration', exact: true }).click()
    await page.waitForURL(origin + '/admin')
    expect(
      (
        await context.request.post(origin + '/admin/api/accounts', { headers: { origin }, data: { username: 'member', password: 'password', email: '' } })
      ).status(),
    ).toBe(201)
    await context.request.post(origin + '/login', { headers: { origin }, form: { username: 'member', password: 'password' }, maxRedirects: 0 })
    expect((await context.request.get(origin + '/admin/api/initial-model')).status()).toBe(403)
    await context.close()
    await app.stop()
    app = undefined
    await removeCommunityFixture(root)
    root = undefined
  }
})

it('allows manual configuration or skipping invalid initialization defaults and does not resume setup on later sign-in', async () => {
  root = await mkdtemp(join(tmpdir(), 'initial-model-skip-'))
  const defaults = join(root, 'initial-model.json')
  await writeFile(defaults, 'invalid fictional-private-value', { mode: 0o600 })
  app = createCommunityApplication({
    initialModelDefaultsFile: defaults,
    listen: { host: '127.0.0.1', port: 0 },
    runtime: {
      command: '/unavailable-dsh',
      args: [],
      dataRoot: root,
      defaultModel: { provider: 'deepseek-official', model: 'fixture', upstream: { baseUrl: 'http://127.0.0.1:1' } },
    },
  })
  const origin = await app.start()
  browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({ locale: 'en' }),
    page = await context.newPage()
  await page.goto(origin + '/bootstrap#credential=' + readBootstrapCredential(root)!.credential)
  await selectBuiltinDatabase(page)
  await page.getByLabel('Username', { exact: true }).fill('admin')
  await page.getByLabel('Password', { exact: true }).fill('password')
  await page.getByRole('button', { name: 'Create administrator', exact: true }).click()
  await page.getByRole('alert').filter({ hasText: 'Initialization defaults could not be read.' }).waitFor()
  expect(await page.getByLabel('API key', { exact: true }).getAttribute('required')).not.toBeNull()
  expect(await page.content()).not.toContain('fictional-private-value')
  await page.getByRole('button', { name: 'Skip for now and finish installation', exact: true }).click()
  await page.waitForURL(origin + '/admin')
  expect((await (await context.request.get(origin + '/admin/api/models')).json()).providers).toEqual([])
  const signed = await context.request.post(origin + '/login', { headers: { origin }, form: { username: 'admin', password: 'password' }, maxRedirects: 0 })
  expect(signed.headers().location).toBe('/admin')
  expect(await readFile(defaults, 'utf8')).toBe('invalid fictional-private-value')
  await rm(defaults)
  await page.goto(origin + '/admin/initial-model')
  await page.getByLabel('Provider name', { exact: true }).fill('Manual provider')
  await page.locator('[name="baseUrl"]').fill('https://manual.example.test/v1')
  await page.getByLabel('API key', { exact: true }).fill('fictional-manual-key')
  await page.getByLabel('Model identifier 1', { exact: true }).fill('manual-model')
  await page.getByRole('button', { name: 'Save model configuration and finish installation', exact: true }).click()
  await page.getByRole('status').filter({ hasText: 'Configuration saved. The model has not been tested.' }).waitFor()
  const manual = await (await context.request.get(origin + '/admin/api/models')).json()
  expect(manual.providers).toHaveLength(1)
  expect(manual.providers[0].name).toBe('Manual provider')
})
