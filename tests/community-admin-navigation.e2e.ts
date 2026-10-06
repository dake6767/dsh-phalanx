import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium, type Browser } from 'playwright'
import { afterEach, expect, it } from 'vitest'
import { createCommunityApplication } from '../src/composition/community-application.js'
import { readBootstrapCredential } from '../src/adapters/bootstrap-credential.js'
import type { CommunityApplication } from '../src/ports/community-application.js'
let app: CommunityApplication | undefined
let browser: Browser | undefined
let root: string | undefined
afterEach(async () => { await browser?.close(); await app?.stop(); if (root) await rm(root, { recursive: true, force: true }) })
it('keeps management addresses, appearance and mobile navigation accessible across refresh', async () => {
  root = await mkdtemp(join(tmpdir(), 'admin-navigation-'))
  app = createCommunityApplication({ listen: { host: '127.0.0.1', port: 0 }, sessionSecret: 'navigation-fixture-session-secret-32-bytes', runtime: { command: '/unavailable-dsh', args: [], dataRoot: root, defaultModel: { provider: 'deepseek-official', model: 'deepseek-chat', upstream: { baseUrl: 'https://api.deepseek.com' } } } })
  const origin = await app.start(); browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ colorScheme: 'dark' }); page.setDefaultTimeout(10_000)
  await page.goto(`${origin}/bootstrap#credential=${readBootstrapCredential(root)!.credential}`)
  await page.getByLabel('Username', { exact: true }).fill('admin'); await page.getByLabel('Password', { exact: true }).fill('password')
  await page.getByRole('button', { name: 'Create administrator' }).click(); await page.waitForURL(`${origin}/admin`)
  await page.getByRole('heading', { name: 'Account management', exact: true }).waitFor()
  expect(await page.locator('html').getAttribute('data-theme')).toBe('dark')
  await page.getByLabel('Appearance', { exact: true }).selectOption('light')
  for (const [path, title] of [['models', 'Model management'], ['settings', 'System settings'], ['accounts', 'Account management']] as const) {
    await page.getByRole('link', { name: title, exact: true }).click(); await page.waitForURL(`${origin}/admin/${path}`)
    await page.reload(); await page.getByRole('heading', { name: title, exact: true }).waitFor()
    expect(await page.locator('html').getAttribute('data-theme')).toBe('light')
  }
  await page.goto(`${origin}/admin#model-settings`); await page.waitForURL(`${origin}/admin/models`)
  await page.setViewportSize({ width: 390, height: 844 }); await page.reload()
  await page.getByRole('button', { name: 'Open navigation', exact: true }).click()
  await page.getByRole('link', { name: 'System settings', exact: true }).click()
  await page.getByRole('heading', { name: 'System settings', exact: true }).waitFor()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  expect((await page.request.get(`${origin}/admin/models`)).status()).toBe(200)
  expect((await (await browser.newContext()).request.get(`${origin}/admin/assets/missing.js`, { maxRedirects: 0 })).status()).toBe(303)
})
