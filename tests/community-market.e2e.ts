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
it('preserves member market APIs, restart confirmation and administrator publication impact', async () => {
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
    await page.getByRole('tab', { name: 'Basic settings', exact: true }).click()
    await page.getByRole('button', { name: 'Publish to Platform App Center', exact: true }).click()
    await page.getByRole('button', { name: 'Unpublish', exact: true }).waitFor()
    const market = await browser.newPage({ locale: 'en' }); market.setDefaultTimeout(15000)
    await market.request.post(origin + '/login', { headers: { origin }, form: { username: 'member', password: 'password' }, maxRedirects: 0 })
    expect((await market.request.get(origin + '/market')).status()).toBe(404)
    expect((await market.request.post(origin + '/market/api/plugins', { headers: { origin: 'https://other.example.test' }, data: { packageName: 'useful-plugin', action: 'install' } })).status()).toBe(403)
    expect((await market.request.post(origin + '/market/api/plugins', { headers: { origin }, data: { packageName: 'useful-plugin', action: 'install' } })).status()).toBe(200)
    const memberMarket = async () => (await (await market.request.get(origin + '/market/api/plugins')).json())
    expect((await memberMarket()).plugins[0]).toMatchObject({ status: 'selected' })
    expect((await memberMarket()).pending).toBe(true)
    expect(installed).toEqual([])
    nextSnapshot = ['useful-plugin@1.0.0:sha512-fixture']
    await market.goto(origin + '/recovery?restart=1')
    await market.getByRole('checkbox').check(); await market.getByRole('button', { name: 'Restart instance', exact: true }).click()
    await market.getByText('Instance restarted. Your saved data is ready.', { exact: true }).waitFor()
    expect((await memberMarket()).plugins[0]).toMatchObject({ status: 'selected' })
    expect((await memberMarket()).pending).toBe(false)
    await page.getByRole('button', { name: 'Unpublish', exact: true }).click()
    await page.getByText('This affects 1 members who selected this plugin.', { exact: true }).waitFor()
    await page.getByRole('button', { name: 'Confirm', exact: true }).click()
    expect((await memberMarket()).plugins).toEqual([])
    expect((await memberMarket()).pending).toBe(true)
    snapshot = []; installed = [{ packageName: 'useful-plugin', version: '0.9.0' }]
    await page.getByRole('button', { name: 'Publish to Platform App Center', exact: true }).click()
    expect((await memberMarket()).plugins[0]).toMatchObject({ status: 'native' })
    expect(installed).toEqual([{ packageName: 'useful-plugin', version: '0.9.0' }])
  } finally { await browser.close(); await app.stop(); await new Promise<void>(resolve => native.close(() => resolve())); await rm(root, { recursive: true, force: true }) }
})
