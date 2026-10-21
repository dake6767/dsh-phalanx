// Validation: T1; real credentials: none; controlled browser/process fixtures. CI selects its explicit public-entry subset.
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium, type Browser } from 'playwright'
import { afterEach, expect, it } from 'vitest'
import { createCommunityApplication } from '../src/composition/community-application.js'
import type { CommunityApplication } from '../src/ports/community-application.js'
import { issueBootstrapCredential, readBootstrapCredential } from '../src/adapters/bootstrap-credential.js'
let app: CommunityApplication | undefined, browser: Browser | undefined, root: string | undefined

afterEach(async () => { await browser?.close(); await app?.stop(); if (root) await rm(root, { recursive: true, force: true }) })
it('keeps themed entry and complete error pages independent of management assets', async () => {
 root = await mkdtemp(join(tmpdir(), 'community-page-browser-'))
 app = createCommunityApplication({ listen: { host: '127.0.0.1', port: 0 }, sessionSecret: 'pages-fixture-session-secret-at-least-32-bytes', runtime: { command: '/unavailable-dsh', args: [], dataRoot: root, defaultModel: { provider: 'deepseek-official', model: 'fixture', upstream: { baseUrl: 'https://api.deepseek.com' } } } })
 const origin = await app.start(); browser = await chromium.launch({ headless: true })
 const context = await browser.newContext({ locale: 'en', colorScheme: 'dark', viewport: { width: 390, height: 844 } }); const page = await context.newPage()
 const adminAssets: string[] = []; page.on('request', request => { if (request.url().includes('/admin/assets/')) adminAssets.push(request.url()) })
 await context.route('**/admin/assets/**', route => route.abort())
 await page.goto(`${origin}/bootstrap`)
 expect(await page.locator('html').getAttribute('data-theme')).toBe('dark')
 expect(await page.getByRole('button', { name: 'Create administrator', exact: true }).isVisible()).toBe(false)
 await page.goto(`${origin}/bootstrap#credential=invalid`)
 await page.getByText('This initialization link is invalid.', { exact: false }).waitFor()
 const expired = issueBootstrapCredential(root, 0)
 const rejected = await context.request.post(`${origin}/bootstrap`, { form: { credential: expired.credential, username: 'admin', password: 'private-submitted-password' }, headers: { origin }, maxRedirects: 0 })
 expect(rejected.status()).toBe(403); expect(rejected.headers()['content-type']).toContain('text/html')
 expect(await rejected.text()).not.toContain(expired.credential); expect(await rejected.text()).not.toContain('private-submitted-password')
 await page.goto(`${origin}/bootstrap#credential=${expired.credential}`)
 await page.getByLabel('Username', { exact: true }).fill('admin'); await page.getByLabel('Password', { exact: true }).fill('private-submitted-password')
 const invalid = page.waitForResponse(response => response.url().includes('/bootstrap') && response.request().method() === 'POST')
 await page.getByRole('button', { name: 'Create administrator', exact: true }).click(); expect((await invalid).status()).toBe(403)
 await page.getByRole('alert').filter({ hasText: 'Invalid or expired' }).waitFor()
 expect(await page.getByLabel('Password', { exact: true }).inputValue()).toBe('')
 expect(adminAssets).toHaveLength(0)
 const valid = issueBootstrapCredential(root)
 expect((await context.request.post(`${origin}/bootstrap`, { headers: { origin }, form: { credential: valid.credential, username: 'admin', password: 'password' }, maxRedirects: 0 })).status()).toBe(303)
 expect(readBootstrapCredential(root)).toBeUndefined()
 const closed = await page.goto(`${origin}/bootstrap`); expect(closed!.status()).toBe(404)
 await page.getByRole('heading', { name: 'Initialization unavailable', exact: true }).waitFor()
 expect(await page.getByRole('button', { name: 'Create administrator', exact: true }).count()).toBe(0)
 await page.getByRole('link', { name: 'Sign in', exact: true }).click()
 await page.getByLabel('Appearance', { exact: true }).selectOption('light')
 await page.getByLabel('Username', { exact: true }).fill('admin'); await page.getByLabel('Password', { exact: true }).fill('wrong-private-password')
 const denied = page.waitForResponse(response => new URL(response.url()).pathname === '/login' && response.request().method() === 'POST')
 await page.getByRole('button', { name: 'Sign in', exact: true }).click(); expect((await denied).status()).toBe(401)
 await page.getByRole('alert').waitFor(); expect(await page.getByLabel('Password', { exact: true }).inputValue()).toBe('')
 expect(await page.content()).not.toContain('wrong-private-password'); expect(await page.locator('html').getAttribute('data-theme')).toBe('light')
 await page.getByLabel('Username', { exact: true }).fill('admin'); await page.getByLabel('Password', { exact: true }).fill('password')
 await page.getByRole('button', { name: 'Sign in', exact: true }).click(); await page.waitForURL(`${origin}/admin`)
 expect((await context.request.post(`${origin}/admin/api/accounts`, { headers: { origin }, data: { username: 'member', email: 'member@example.test', password: 'password' } })).status()).toBe(201)
 const attemptedAdminAssets = adminAssets.length
 expect((await context.request.post(`${origin}/login`, { headers: { origin }, form: { username: 'member', password: 'password' }, maxRedirects: 0 })).status()).toBe(303)
 expect((await context.request.get(`${origin}/admin/api/session`)).status()).toBe(403)
 await page.goto(`${origin}/recovery?restart=1`); await page.getByRole('heading', { name: 'Instance recovery', exact: true }).waitFor()
 expect(await page.locator('html').getAttribute('data-theme')).toBe('light')
 await page.getByRole('checkbox').check(); await page.getByRole('button', { name: 'Restart instance', exact: true }).click()
 await page.getByRole('status').filter({ hasText: 'Restart failed.' }).waitFor()
 expect(await page.getByRole('button', { name: 'Restart instance', exact: true }).isEnabled()).toBe(true)
 expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
 await page.screenshot({ path: join(process.env.DSH_PHALANX_E2E_EVIDENCE_DIR ?? root!, 'phalanx-recovery-light-mobile.png'), fullPage: true })
 await page.getByRole('button', { name: 'Log out', exact: true }).click(); await page.waitForURL(`${origin}/login`)
 expect(adminAssets.length).toBeGreaterThan(0)
 expect(adminAssets).toHaveLength(attemptedAdminAssets)
 // Only the deliberately attempted management navigation requested its bundle.
 expect(await page.locator('script[src]').count()).toBe(0)
})

it('keeps bilingual narrow startup failures on the bookmarked address and enters only after a confirmed retry', async () => {
 const { createServer } = await import('node:http')
 const { CommunityInstanceLifecycle } = await import('../src/use-cases/community-instance-lifecycle.js')
 const nativeMethods: string[] = []
 const target = createServer((request, response) => {
  nativeMethods.push(request.method ?? 'GET')
  if (request.url === '/launch') { response.writeHead(303, { location: '/', 'set-cookie': 'native_fixture=ready; Path=/; HttpOnly' }); response.end(); return }
  if (!(request.headers.cookie ?? '').includes('native_fixture=ready')) { response.writeHead(401); response.end(); return }
  response.setHeader('content-type', 'text/html'); response.end('<div id="root">NATIVE_WORKSPACE_READY</div>')
 })
 await new Promise<void>(resolve => { target.listen(0, '127.0.0.1', resolve) })
 const address = target.address(); if (!address || typeof address === 'string') throw Error('No browser fixture listener')
 const targetOrigin = `http://127.0.0.1:${address.port}`
 let release: () => void = () => {}
 try {
  browser = await chromium.launch({ headless: true })
  for (const locale of ['en', 'zh-CN'] as const) {
   root = await mkdtemp(join(tmpdir(), 'startup-page-browser-'))
   let generation = 0, complete!: () => void
   let gate = new Promise<void>(resolve => { complete = resolve }); release = () => { complete() }
   const runtime = new CommunityInstanceLifecycle({ rebuild: async () => [], alive: async () => true, stop: async () => {}, detach: async () => {},
    start: async userId => {
     const current = ++generation; await gate
     if (current === 1) throw Error('PRIVATE_HOST_CREDENTIAL')
     return { userId, processId: current, origin: targetOrigin, launchUrl: targetOrigin + '/launch' }
    } }, () => ({ url: targetOrigin, token: 'fictional' }))
   app = createCommunityApplication({ listen: { host: '127.0.0.1', port: 0 }, sessionSecret: 'startup-browser-fixture-secret-at-least-32-bytes', idleReclaimSeconds: 0,
    runtime: { command: '/unused', args: [], dataRoot: root, defaultModel: { provider: 'deepseek-official', model: 'fixture', upstream: { baseUrl: targetOrigin } } } }, { runtime })
   const origin = await app.start(), context = await browser.newContext({ locale, colorScheme: 'dark', viewport: { width: 320, height: 700 } }), page = await context.newPage()
   const bootstrap = await context.request.post(origin + '/bootstrap', { headers: { origin }, form: { credential: readBootstrapCredential(root)!.credential, username: 'admin', password: 'password' }, maxRedirects: 0 })
   expect(bootstrap.status()).toBe(303)
   expect((await context.request.post(origin + '/admin/api/accounts', { headers: { origin }, data: { username: 'member', email: '', password: 'password' } })).status()).toBe(201)
   await page.goto(origin + '/login')
   await page.getByLabel(locale === 'en' ? 'Username' : '用户名', { exact: true }).fill('member')
   await page.getByLabel(locale === 'en' ? 'Password' : '密码', { exact: true }).fill('password')
   const login = page.waitForResponse(response => new URL(response.url()).pathname === '/login' && response.request().method() === 'POST')
   await page.getByRole('button', { name: locale === 'en' ? 'Sign in' : '登录', exact: true }).click({ noWaitAfter: true })
   expect((await login).status()).toBe(303)
   await page.locator('[data-platform-startup]').waitFor()
   const bookmark = page.url() + '?view=saved#position'
   await page.goto(bookmark); await page.locator('[data-platform-startup]').waitFor()
   const posted = page.waitForResponse(response => response.request().isNavigationRequest() && response.request().method() === 'POST')
   await page.evaluate(url => { const form = document.createElement('form'); form.method = 'POST'; form.action = url; document.body.append(form); form.submit() }, bookmark)
   expect((await posted).status()).toBe(200); await page.waitForLoadState('domcontentloaded')
   await page.locator('[data-platform-startup]').waitFor()
   expect(await page.locator('html').getAttribute('data-theme')).toBe('dark')
   expect(await page.locator('script[src],link[rel=stylesheet],#root').count()).toBe(0)
   expect(await page.locator('#stage').textContent()).toBe(locale === 'en' ? 'Preparing plugins and skills' : '准备插件与技能')
   await page.clock.install(); await page.clock.fastForward(15_001)
   await page.locator('#slow').waitFor({ state: 'visible' })
   complete(); await page.clock.fastForward(1001)
   await page.locator('#failure').waitFor({ state: 'visible' })
   expect(await page.content()).not.toContain('PRIVATE_HOST_CREDENTIAL')
   let phaseRequests = 0, navigations = 0
   page.on('request', request => { if (new URL(request.url()).pathname === '/account/startup') phaseRequests++; if (request.isNavigationRequest()) navigations++ })
   await page.clock.fastForward(60_000)
   expect(phaseRequests).toBe(0); expect(navigations).toBe(0); expect(page.url()).toBe(bookmark)
   expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
   expect(await page.getByRole('link', { name: locale === 'en' ? 'More recovery options' : '更多恢复选项', exact: true }).getAttribute('href')).toBe('/recovery')
   gate = new Promise<void>(resolve => { complete = resolve })
   await page.getByRole('checkbox').check()
   await page.getByRole('button', { name: locale === 'en' ? 'Restart instance' : '重启实例', exact: true }).click({ noWaitAfter: true })
   await expect.poll(() => generation).toBe(2)
   complete()
   await page.locator('#root').waitFor({ state: 'attached' })
   expect(page.url()).toBe(bookmark); expect(await page.locator('#root').textContent()).toBe('NATIVE_WORKSPACE_READY')
   expect(generation).toBe(2); expect(nativeMethods).not.toContain('POST')
   await context.close(); await app.stop(); app = undefined; await rm(root, { recursive: true, force: true }); root = undefined
  }
 } finally {
  release(); target.closeAllConnections(); await new Promise<void>((resolve, reject) => { target.close(error => error ? reject(error) : resolve()) })
 }
})
