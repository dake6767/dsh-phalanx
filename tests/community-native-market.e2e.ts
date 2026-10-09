import { mkdtemp, rm, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { expect, it } from 'vitest'
import type { CommunityMarketPluginView } from '../src/domain/admin-contract.js'
import { candidateApplication } from './support/candidate-application.js'
import { CommunityAccountStore } from '../src/adapters/community-account-store.js'
import { CommunityRuntimeDriver } from '../src/adapters/community-runtime-driver.js'
import { runtimeSettings } from './support/real-dsh-kit.js'
import { assertPinnedDshRevision, runtimeSection } from './support/real-dsh-runtime.js'
import { signInCommunity } from './fixtures/community-native-browser.js'

it('renders the platform market with native DSH controls, theme and locale while retaining install feedback', async () => {
  assertPinnedDshRevision(runtimeSettings)
  const root = await mkdtemp(join(tmpdir(), 'native-market-'))
  const runtime = runtimeSection(root, 'https://example.test', runtimeSettings)
  const app = candidateApplication({ listen: { host: '127.0.0.1', port: 0 }, sessionSecret: 'native-market-fixture-secret-32-bytes', runtime })
  const store = new CommunityAccountStore(join(root, 'community-accounts.db'))
  await store.create({ username: 'member', email: 'member@example.test', password: 'password' }); store.close()
  const browser = await chromium.launch({ headless: true })
  try {
    const origin = await app.start(); const page = await browser.newPage({ locale: 'en', colorScheme: 'light' }); page.setDefaultTimeout(30_000)
    let status: CommunityMarketPluginView['status'] = 'install'; let restartPending = false; let posts = 0; let fail = false; let empty = false; let block = false
    let entered!: () => void; const pendingPost = new Promise<void>(resolve => { entered = resolve })
    await page.route('**/market/api/plugins', async route => {
      if (route.request().method() === 'POST') {
        posts++; expect(route.request().postDataJSON()).toEqual({ packageName: 'example-sidebar', action: status === 'selected' ? 'uninstall' : 'install' })
        if (block) { entered(); return }
        if (fail) { await route.fulfill({ status: 409, json: { code: 'plugin-not-published', error: 'Plugin is no longer published.' } }); return }
        const application = 'restart-required'; status = status === 'selected' ? 'install' : 'selected'; restartPending = true
        await route.fulfill({ json: { application } }); return
      }
      await route.fulfill({ json: { pending: restartPending, plugins: empty ? [] : [{ packageName: 'example-sidebar', title: 'Useful sidebar', description: 'Read files in a sidebar.', version: '1.0.0', status }] } })
    })
    await signInCommunity(page, origin, 'member', 'password')
    await page.getByRole('button', { name: 'Platform apps', exact: true }).click()
    const market = page.getByRole('region', { name: 'Platform apps', exact: true })
    await market.getByRole('heading', { name: 'Useful sidebar', exact: true }).waitFor()
    expect(await market.locator('iframe').count()).toBe(0)
    const button = market.getByRole('button', { name: 'Install', exact: true })
    expect(await button.getAttribute('class')).toMatch(/outline/)
    await button.click(); await market.getByText('Changes take effect after restarting your instance.', { exact: true }).waitFor()
    expect(posts).toBe(1)
    await market.getByRole('button', { name: 'Uninstall', exact: true }).waitFor()
    status = 'selected'; fail = true
    await market.getByRole('button', { name: 'Reload plugins', exact: true }).click()
    await market.getByRole('button', { name: 'Uninstall', exact: true }).click()
    await market.getByRole('alert').waitFor()
    fail = false
    await market.getByRole('button', { name: 'Uninstall', exact: true }).click()
    await market.getByRole('link', { name: 'Restart DSH instance', exact: true }).waitFor()
    block = true; status = 'install'
    await market.getByRole('button', { name: 'Reload plugins', exact: true }).click()
    const aborted = page.waitForEvent('requestfailed', request => request.url().endsWith('/market/api/plugins') && request.method() === 'POST')
    await market.getByRole('button', { name: 'Install', exact: true }).click(); await pendingPost
    await page.getByRole('button', { name: 'Plugins', exact: true }).click(); await aborted
    await page.getByRole('button', { name: 'Platform apps', exact: true }).click()
    await market.getByRole('heading', { name: 'Useful sidebar', exact: true }).waitFor()
    const light = await market.evaluate(element => getComputedStyle(element).color)
    await page.emulateMedia({ colorScheme: 'dark' })
    await expect.poll(() => market.evaluate(element => getComputedStyle(element).color)).not.toBe(light)
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    await page.getByRole('button', { name: 'English', exact: true }).click()
    await page.getByRole('menuitem', { name: '中文', exact: true }).click(); await page.keyboard.press('Escape')
    await page.getByRole('heading', { name: '平台应用', exact: true }).waitFor()
    const evidence = process.env.DSH_PHALANX_E2E_EVIDENCE_DIR
    if (evidence) { await mkdir(evidence, { recursive: true }); await page.screenshot({ path: join(evidence, 'native-market-dark.png'), fullPage: true }) }
    await page.emulateMedia({ colorScheme: 'light' })
    if (evidence) await page.screenshot({ path: join(evidence, 'native-market-light.png'), fullPage: true })
    await page.setViewportSize({ width: 390, height: 844 })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    if (evidence) await page.screenshot({ path: join(evidence, 'native-market-mobile.png'), fullPage: true })
    empty = true
    await page.getByRole('button', { name: '重新加载插件', exact: true }).click()
    await page.getByText('暂无已发布的插件', { exact: true }).waitFor()
  } finally { await browser.close(); await app.stop(); await new CommunityRuntimeDriver(runtime).rebuild(); await rm(root, { recursive: true, force: true }) }
})
