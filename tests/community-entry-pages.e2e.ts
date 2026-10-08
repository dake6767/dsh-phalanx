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
 await page.screenshot({ path: '/tmp/phalanx-recovery-light-mobile.png', fullPage: true })
 await page.getByRole('button', { name: 'Log out', exact: true }).click(); await page.waitForURL(`${origin}/login`)
 expect(adminAssets.length).toBeGreaterThan(0)
 expect(adminAssets).toHaveLength(attemptedAdminAssets)
 // Only the deliberately attempted management navigation requested its bundle.
 expect(await page.locator('script[src]').count()).toBe(0)
})
