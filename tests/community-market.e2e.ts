// Validation: T1; real credentials: none; controlled browser/process fixtures. CI selects its explicit public-entry subset.
import { mkdtemp } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { expect, it } from 'vitest'
import { readBootstrapCredential } from '../src/adapters/bootstrap-credential.js'
import { declaredRuntimeRevision } from '../src/adapters/runtime-revision.js'
import { BusinessRuleError } from '../src/domain/business-error.js'
import type { CommunityRuntimePort } from '../src/ports/community-runtime.js'
import { removeCommunityFixture } from './fixtures/owned-cleanup.js'
import { createCommunityApplication } from './support/community-application.js'
import { selectBuiltinDatabase } from './support/community-bootstrap-browser.js'
it('keeps accepted native work alive, retries failures and preserves shared-key restart/publication behavior', async () => {
  const root = await mkdtemp(join(tmpdir(), 'market-ui-'))
  const native = createServer((_req, res) => {
    res.writeHead(303, { 'set-cookie': 'native=fixture' })
    res.end()
  })
  await new Promise<void>(resolve => native.listen(0, '127.0.0.1', resolve))
  const address = native.address()
  if (!address || typeof address === 'string') throw Error('missing address')
  let installed: { packageName: string; version: string; retainedArchive?: true }[] = [],
    snapshot: string[] = [],
    nextSnapshot: string[] = []
  const instance = (userId: string) => ({
    userId,
    origin: `http://127.0.0.1:${address.port}`,
    launchUrl: `http://127.0.0.1:${address.port}`,
    processId: 1,
    managedSnapshot: snapshot,
  })
  const runtime: CommunityRuntimePort = {
    ensure: async username => instance(username),
    restart: async username => {
      snapshot = nextSnapshot
      return instance(username)
    },
    recover: async username => instance(username),
    reclaim: async () => 'not-running',
    terminate: async () => {},
    status: username => ({ state: 'ready', instance: instance(username) }),
    stopAll: async () => {},
    reconcileStartupContainers: async () => ({ adopted: [], swept: [] }),
  }
  let finish!: () => void,
    failInstall = false
  const completion = new Promise<void>(resolve => {
    finish = resolve
  })
  const app = createCommunityApplication(
    {
      listen: { host: '127.0.0.1', port: 0 },
      sessionSecret: 'market-ui-fixture-secret-value-32',
      runtime: {
        command: '/unavailable',
        args: [],
        dataRoot: root,
        defaultModel: { provider: 'deepseek-official', model: 'fixture', upstream: { baseUrl: 'https://example.test' } },
      },
    },
    {
      runtime,
      pluginPreparer: {
        prepare: async input => ({
          ...input,
          title: 'Useful plugin',
          description: 'A shared plugin.',
          artifact: 'artifacts/fixture',
          integrity: 'sha512-fixture',
          runtimeRevision: declaredRuntimeRevision(),
          bundlePatch: '[]',
          dependencies: {},
        }),
      },
      pluginManager: {
        list: async () => installed,
        install: async (_instance, _origin, _archive, options) => {
          options.progress?.('downloading')
          await completion
          if (failInstall) throw new BusinessRuleError('conflict', 'Build approval is required.', 'plugin-install-failed', { reason: 'build-blocked' })
          installed = [{ packageName: 'useful-plugin', version: '1.0.0', retainedArchive: true }]
          return 'applied'
        },
        remove: async () => {
          installed = []
          return 'applied'
        },
      },
    },
  )
  const browser = await chromium.launch({ headless: true })
  try {
    const origin = await app.start()
    const page = await browser.newPage({ locale: 'en' })
    page.setDefaultTimeout(15000)
    if (process.env.DSH_PHALANX_E2E_CPU_THROTTLE) await (await page.context().newCDPSession(page)).send('Emulation.setCPUThrottlingRate', { rate: 4 })
    expect((await page.request.get(origin + '/market/api/plugins')).status()).toBe(401)
    await page.goto(`${origin}/bootstrap#credential=${readBootstrapCredential(root)!.credential}`)
    await selectBuiltinDatabase(page)
    await page.getByLabel('Username', { exact: true }).fill('admin')
    await page.getByLabel('Password', { exact: true }).fill('password')
    await page.getByRole('button', { name: 'Create administrator' }).click()
    await page.waitForURL(`${origin}/admin`)
    const post = (path: string, data: object) => page.request.post(origin + '/admin/api/' + path, { headers: { origin }, data })
    expect((await post('accounts', { username: 'member', password: 'password', email: '' })).status()).toBe(201)
    expect((await post('plugins', { action: 'add', packageName: 'useful-plugin', version: '1.0.0' })).status()).toBe(202)
    await page.getByRole('link', { name: 'Plugin library', exact: true }).click()
    await page.getByRole('button', { name: 'View plugin useful-plugin', exact: true }).click()
    await page.getByRole('tab', { name: 'Basic settings', exact: true }).click()
    await page.getByRole('button', { name: 'Publish to Platform App Center', exact: true }).click()
    await page.getByRole('button', { name: 'Unpublish', exact: true }).waitFor()
    let market = await browser.newPage({ locale: 'en' })
    market.setDefaultTimeout(15000)
    await market.request.post(origin + '/login', { headers: { origin }, form: { username: 'member', password: 'password' }, maxRedirects: 0 })
    expect((await market.request.get(origin + '/market')).status()).toBe(404)
    expect(
      (
        await market.request.post(origin + '/market/api/plugins', {
          headers: { origin: 'https://other.example.test' },
          data: { packageName: 'useful-plugin', action: 'install' },
        })
      ).status(),
    ).toBe(403)
    const memberMarket = async () => await (await market.request.get(origin + '/market/api/plugins')).json()
    const action = (action: 'install' | 'uninstall', requestId: string) =>
      market.request.post(origin + '/market/api/plugins', { headers: { origin }, data: { packageName: 'useful-plugin', action, requestId } })
    const accepted = await action('install', 'install-1')
    expect(accepted.status()).toBe(202)
    expect(await accepted.json()).toMatchObject({ job: { requestId: 'install-1', status: 'running' } })
    await expect.poll(async () => (await memberMarket()).plugins[0]?.job?.phase).toBe('downloading')
    expect(installed).toEqual([])
    await market.close()
    finish()
    market = await browser.newPage({ locale: 'en' })
    await market.request.post(origin + '/login', { headers: { origin }, form: { username: 'member', password: 'password' }, maxRedirects: 0 })
    await expect.poll(async () => (await memberMarket()).plugins[0]?.job?.status).toBe('succeeded')
    expect((await memberMarket()).plugins[0]).toMatchObject({ status: 'installed' })
    expect((await memberMarket()).pending).toBe(false)
    expect((await action('uninstall', 'remove-1')).status()).toBe(202)
    await expect.poll(async () => (await memberMarket()).plugins[0]?.status).toBe('install')
    failInstall = true
    expect((await action('install', 'install-2')).status()).toBe(202)
    await expect.poll(async () => (await memberMarket()).plugins[0]?.job?.status).toBe('failed')
    expect((await memberMarket()).plugins[0].job.failure).toMatchObject({ code: 'plugin-install-failed', params: { reason: 'build-blocked' } })
    failInstall = false
    expect((await action('install', 'install-3')).status()).toBe(202)
    await expect.poll(async () => (await memberMarket()).plugins[0]?.status).toBe('installed')
    expect((await action('uninstall', 'remove-3')).status()).toBe(202)
    await expect.poll(async () => (await memberMarket()).plugins[0]?.status).toBe('install')
    installed = [{ packageName: 'useful-plugin', version: '0.9.0' }]
    expect((await action('install', 'independent')).status()).toBe(409)
    expect((await memberMarket()).plugins[0]?.status).toBe('native')
    expect(installed[0]?.version).toBe('0.9.0')
    installed = []
    expect(
      (
        await post('plugins/upstreams?packageName=useful-plugin', {
          action: 'save',
          upstream: { name: 'shared', baseUrl: 'https://example.test', credential: 'fixture-shared-key', headers: [] },
        })
      ).status(),
    ).toBe(200)
    expect((await action('install', 'shared-1')).status()).toBe(200)
    expect((await memberMarket()).plugins[0]).toMatchObject({ status: 'selected', sharedCredential: true })
    expect((await memberMarket()).pending).toBe(true)
    expect(installed).toEqual([])
    nextSnapshot = ['useful-plugin@1.0.0:sha512-fixture']
    await market.goto(origin + '/recovery?restart=1')
    await market.locator('#restart').getByRole('checkbox').check()
    await market.getByRole('button', { name: 'Restart instance', exact: true }).click()
    await market.getByText('Instance restarted. Your saved data is ready.', { exact: true }).waitFor()
    expect((await memberMarket()).plugins[0]).toMatchObject({ status: 'selected' })
    expect((await memberMarket()).pending).toBe(false)
    await page.getByRole('button', { name: 'Unpublish', exact: true }).click()
    await page.getByText('This affects 1 members who selected this plugin.', { exact: true }).waitFor()
    await page
      .getByRole('dialog', { name: 'Confirm unpublishing', exact: true })
      .getByText('Installed member copies are kept. Group grants remain; shared-key selections stop loading after restart.', { exact: true })
      .waitFor()
    const unpublished = page.waitForResponse(
      response => new URL(response.url()).pathname === '/admin/api/plugins/publication' && response.request().method() === 'POST',
    )
    await page.getByRole('button', { name: 'Confirm', exact: true }).click()
    expect((await unpublished).status()).toBe(200)
    expect((await memberMarket()).plugins).toEqual([])
    expect((await memberMarket()).pending).toBe(true)
    snapshot = []
    installed = [{ packageName: 'useful-plugin', version: '0.9.0' }]
    await page.getByRole('button', { name: 'Publish to Platform App Center', exact: true }).click()
    await page.getByRole('dialog', { name: 'Confirm publication', exact: true }).getByRole('button', { name: 'Confirm', exact: true }).click()
    await page.getByRole('button', { name: 'Unpublish', exact: true }).waitFor()
    expect((await memberMarket()).plugins[0]).toMatchObject({ status: 'native' })
    expect(installed).toEqual([{ packageName: 'useful-plugin', version: '0.9.0' }])
  } finally {
    finish()
    await browser.close()
    await app.stop()
    await new Promise<void>(resolve => native.close(() => resolve()))
    await removeCommunityFixture(root)
  }
})
