import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { expect, it } from 'vitest'
import { createCommunityApplication } from '../src/composition/community-application.js'
import { readBootstrapCredential } from '../src/adapters/bootstrap-credential.js'
import { declaredRuntimeRevision } from '../src/adapters/runtime-revision.js'
import type { CommunityRuntimePort } from '../src/ports/community-runtime.js'
it('publishes from the admin drawer and shows member install/update states in both languages', async () => {
  const root = await mkdtemp(join(tmpdir(), 'market-ui-'))
  let installed: { packageName: string, version: string }[] = []
  const instance = { userId: 'admin', origin: 'http://example.test', launchUrl: 'http://example.test', processId: 1 }
  const runtime: CommunityRuntimePort = { ensure: async () => instance, restart: async () => instance, recover: async () => instance, reclaim: async () => 'not-running', terminate: async () => {}, status: () => ({ state: 'stopped' }), stopAll: async () => {}, reconcileStartupContainers: async () => ({ adopted: [], swept: [] }) }
  const app = createCommunityApplication({ listen: { host: '127.0.0.1', port: 0 }, sessionSecret: 'market-ui-fixture-secret-value-32', runtime: { command: '/unavailable', args: [], dataRoot: root, defaultModel: { provider: 'deepseek-official', model: 'fixture', upstream: { baseUrl: 'https://example.test' } } } }, {
    runtime, pluginPreparer: { prepare: async input => ({ ...input, title: 'Useful plugin', description: 'A shared plugin.', artifact: 'artifacts/fixture', integrity: 'sha512-fixture', runtimeRevision: declaredRuntimeRevision(), bundlePatch: '[]', dependencies: {} }) },
    pluginManager: { list: async () => installed, install: async (_instance, _origin, url) => { expect(new URL(url).hostname).toBe('plugins.dsh-phalanx.invalid'); installed = [{ packageName: 'useful-plugin', version: '1.0.0' }]; return 'applied' } },
  })
  const browser = await chromium.launch({ headless: true })
  try {
    const origin = await app.start(); const context = await browser.newContext({ locale: 'en' }); const page = await context.newPage(); page.setDefaultTimeout(15000)
    expect((await page.request.get(origin + '/market/api/plugins')).status()).toBe(401)
    await page.goto(`${origin}/bootstrap#credential=${readBootstrapCredential(root)!.credential}`)
    await page.getByLabel('Username', { exact: true }).fill('admin'); await page.getByLabel('Password', { exact: true }).fill('password')
    await page.getByRole('button', { name: 'Create administrator' }).click(); await page.waitForURL(`${origin}/admin`)
    expect((await page.request.post(origin + '/admin/api/plugins', { headers: { origin }, data: { action: 'add', packageName: 'useful-plugin', version: '1.0.0' } })).status()).toBe(202)
    await page.getByRole('link', { name: 'Plugin library', exact: true }).click()
    const filter = async (name: string) => {
      await page.getByRole('button', { name: /Filter by publication/ }).click()
      await page.getByRole('option', { name, exact: true }).click()
    }
    await filter('Published to marketplace')
    await page.getByText('No plugins match this filter.', { exact: true }).waitFor()
    expect(await page.getByText('0 plugins', { exact: true }).isVisible()).toBe(true)
    await page.getByRole('button', { name: 'Show all plugins', exact: true }).click()
    await page.getByRole('button', { name: 'View plugin useful-plugin', exact: true }).waitFor()
    await filter('Not published')
    await page.getByRole('button', { name: 'View plugin useful-plugin', exact: true }).click()
    await page.getByRole('button', { name: 'Publish to marketplace', exact: true }).click()
    await page.getByRole('button', { name: 'Unpublish', exact: true }).waitFor()
    await expect.poll(() => page.getByRole('button', { name: 'View plugin useful-plugin', exact: true }).count()).toBe(0)
    await page.getByRole('button', { name: 'Close plugin details', exact: true }).click()
    await page.getByText('No plugins match this filter.', { exact: true }).waitFor()
    await filter('Published to marketplace')
    expect(await page.getByText('1 plugins', { exact: true }).isVisible()).toBe(true)
    await page.getByRole('button', { name: 'View plugin useful-plugin', exact: true }).click()
    const market = await page.context().newPage(); await market.goto(origin + '/market?locale=zh-CN')
    await market.getByRole('heading', { name: '平台应用', exact: true }).waitFor()
    await market.getByRole('button', { name: '安装', exact: true }).click()
    await market.getByRole('button', { name: '已安装', exact: true }).waitFor()
    installed = [{ packageName: 'useful-plugin', version: '0.9.0' }]
    await market.goto(origin + '/market?locale=en')
    await market.getByRole('button', { name: 'Update available', exact: true }).waitFor()
    expect(await market.locator('body').innerText()).not.toContain('plugin-archive')
    await page.getByRole('button', { name: 'Unpublish', exact: true }).click()
    await expect.poll(() => page.getByRole('button', { name: 'View plugin useful-plugin', exact: true }).count()).toBe(0)
    await page.getByRole('button', { name: 'Close plugin details', exact: true }).click()
    await page.getByText('No plugins match this filter.', { exact: true }).waitFor()
    await filter('Not published')
    await page.getByRole('button', { name: 'View plugin useful-plugin', exact: true }).waitFor()
    await market.getByRole('button', { name: 'Reload plugins', exact: true }).click()
    await market.getByText('No published plugins', { exact: true }).waitFor()
    expect(installed).toHaveLength(1)
    await context.clearCookies()
    await market.getByRole('button', { name: 'Reload plugins', exact: true }).click()
    await market.waitForURL(origin + '/login')
  } finally { await browser.close(); await app.stop(); await rm(root, { recursive: true, force: true }) }
})
