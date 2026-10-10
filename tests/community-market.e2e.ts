import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { expect, it } from 'vitest'
import { createCommunityApplication } from '../src/composition/community-application.js'
import { readBootstrapCredential } from '../src/adapters/bootstrap-credential.js'
import { declaredRuntimeRevision } from '../src/adapters/runtime-revision.js'
import type { CommunityRuntimePort } from '../src/ports/community-runtime.js'
it('records choices, restarts through the existing confirmation and confirms unpublishing impact', async () => {
  const root = await mkdtemp(join(tmpdir(), 'market-ui-'))
  const native = createServer((_req, res) => { res.writeHead(303, { 'set-cookie': 'native=fixture' }); res.end() })
  await new Promise<void>(resolve => native.listen(0, '127.0.0.1', resolve))
  const address = native.address(); if (!address || typeof address === 'string') throw Error('missing address')
  let installed: { packageName: string, version: string }[] = [], snapshot: string[] = [], nextSnapshot: string[] = []
  const instance = (userId: string) => ({ userId, origin: `http://127.0.0.1:${address.port}`, launchUrl: `http://127.0.0.1:${address.port}`, processId: 1, managedSnapshot: snapshot })
  const runtime: CommunityRuntimePort = { ensure: async username => instance(username), restart: async username => { snapshot = nextSnapshot; return instance(username) }, recover: async username => instance(username), reclaim: async () => 'not-running', terminate: async () => {}, status: username => ({ state: 'ready', instance: instance(username) }), stopAll: async () => {}, reconcileStartupContainers: async () => ({ adopted: [], swept: [] }) }
  const app = createCommunityApplication({ listen: { host: '127.0.0.1', port: 0 }, sessionSecret: 'market-ui-fixture-secret-value-32', runtime: { command: '/unavailable', args: [], dataRoot: root, defaultModel: { provider: 'deepseek-official', model: 'fixture', upstream: { baseUrl: 'https://example.test' } } } }, {
    runtime, pluginPreparer: { prepare: async input => ({ ...input, title: 'Useful plugin', description: 'A shared plugin.', artifact: 'artifacts/fixture', integrity: 'sha512-fixture', runtimeRevision: declaredRuntimeRevision(), bundlePatch: '[]', dependencies: {} }) }, pluginManager: { list: async () => installed },
  })
  const browser = await chromium.launch({ headless: true })
  try {
    const origin = await app.start(); const page = await browser.newPage({ locale: 'en' }); page.setDefaultTimeout(15000)
    expect((await page.request.get(origin + '/market/api/plugins')).status()).toBe(401)
    await page.goto(`${origin}/bootstrap#credential=${readBootstrapCredential(root)!.credential}`)
    await page.getByLabel('Username', { exact: true }).fill('admin'); await page.getByLabel('Password', { exact: true }).fill('password')
    await page.getByRole('button', { name: 'Create administrator' }).click(); await page.waitForURL(`${origin}/admin`)
    const post = (path: string, data: object) => page.request.post(origin + '/admin/api/' + path, { headers: { origin }, data })
    expect((await post('accounts', { username: 'member', password: 'password', email: '' })).status()).toBe(201)
    expect((await post('plugins', { action: 'add', packageName: 'useful-plugin', version: '1.0.0' })).status()).toBe(202)
    await page.getByRole('link', { name: 'Plugin library', exact: true }).click()
    await page.getByRole('button', { name: 'View plugin useful-plugin', exact: true }).click()
    await page.getByRole('tab', { name: 'Publication', exact: true }).click()
    await page.getByRole('button', { name: 'Publish to marketplace', exact: true }).click()
    await page.getByRole('button', { name: 'Unpublish', exact: true }).waitFor()
    const market = await browser.newPage({ locale: 'en' }); market.setDefaultTimeout(15000)
    await market.request.post(origin + '/login', { headers: { origin }, form: { username: 'member', password: 'password' }, maxRedirects: 0 })
    await market.goto(origin + '/market?locale=en')
    await market.getByRole('button', { name: 'Install', exact: true }).click()
    await market.getByRole('button', { name: 'Uninstall', exact: true }).waitFor()
    await market.getByText('Changes take effect after restarting your instance.', { exact: true }).waitFor()
    expect(installed).toEqual([])
    nextSnapshot = ['useful-plugin@1.0.0:sha512-fixture']
    await market.getByRole('link', { name: 'Restart DSH instance', exact: true }).click()
    await market.getByRole('checkbox').check(); await market.getByRole('button', { name: 'Restart instance', exact: true }).click()
    await market.getByText('Instance restarted. Your saved data is ready.', { exact: true }).waitFor()
    await market.goto(origin + '/market?locale=zh-CN')
    await market.getByText('已安装（平台应用中心）', { exact: true }).waitFor()
    expect(await market.getByRole('link', { name: '重启 DSH 实例', exact: true }).count()).toBe(0)
    await page.getByRole('button', { name: 'Unpublish', exact: true }).click()
    await page.getByText('This affects 1 members who selected this plugin.', { exact: true }).waitFor()
    await page.getByRole('button', { name: 'Confirm', exact: true }).click()
    await market.getByRole('button', { name: '重新加载插件', exact: true }).click()
    await market.getByText('暂无已发布的插件', { exact: true }).waitFor()
    await market.getByText('重启实例后生效。', { exact: true }).waitFor()
    snapshot = []; installed = [{ packageName: 'useful-plugin', version: '0.9.0' }]
    await page.getByRole('button', { name: 'Publish to marketplace', exact: true }).click()
    await market.getByRole('button', { name: '重新加载插件', exact: true }).click()
    await market.getByText('已在原生插件页安装', { exact: true }).waitFor()
    expect(await market.getByRole('button', { name: '已安装', exact: true }).isDisabled()).toBe(true)
    expect(installed).toEqual([{ packageName: 'useful-plugin', version: '0.9.0' }])
  } finally { await browser.close(); await app.stop(); await new Promise<void>(resolve => native.close(() => resolve())); await rm(root, { recursive: true, force: true }) }
})
