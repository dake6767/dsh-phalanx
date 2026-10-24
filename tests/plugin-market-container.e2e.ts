// Validation: T2; real credentials: none; installed platform, actual rootless DSH and real plugin settings.
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { expect, it, onTestFinished } from 'vitest'
import { candidateApplication } from './support/candidate-application.js'
import { readBootstrapCredential } from '../src/adapters/bootstrap-credential.js'
import { CommunityRuntimeDriver } from '../src/adapters/community-runtime-driver.js'
import { runtimeSection, assertPinnedDshRevision } from './support/real-dsh-runtime.js'
import { runtimeSettings } from './support/real-dsh-kit.js'
import { cookieHeader, createRealDshRpc } from './support/real-dsh-rpc.js'
import { openNativeSettings, signInCommunity } from './fixtures/community-native-browser.js'
import type { CommunityMarketPageData, CommunityPluginView } from '../src/domain/admin-contract.js'

it.skipIf(!runtimeSettings.containerImage)('installs Better Sidebar from the app center, retains real settings, and removes the native dependency from either interface while shelf changes retain installed copies', async () => {
  assertPinnedDshRevision(runtimeSettings)
  const root = await mkdtemp(join(tmpdir(), 'plugin-market-')), runtime = runtimeSection(join(root, 'data'), 'https://example.test', runtimeSettings)
  const app = candidateApplication({ listen: { host: '127.0.0.1', port: 0 }, sessionSecret: 'native-market-container-fictional-secret', runtime })
  const browser = await chromium.launch({ headless: true }), admin = await browser.newPage({ locale: 'en' }), page = await browser.newPage({ locale: 'en' })
  page.setDefaultTimeout(30000)
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message))
  const packageName = 'dsh-better-sidebar', version = '0.28.0', rpc = createRealDshRpc()
  let primaryFailure: unknown
  const cleanupErrors: unknown[] = []
  let phase = 'startup', cleanupPromise: Promise<void> | undefined
  const startedAt = Date.now(), timeline: { phase: string, elapsedMs: number, stage?: string, failureCode?: string }[] = []
  const mark = (next: string, stage?: string, failureCode?: string) => { phase = next; timeline.push({ phase, elapsedMs: Date.now() - startedAt, ...stage === undefined ? {} : { stage }, ...failureCode === undefined ? {} : { failureCode } }) }
  const cleanup = () => cleanupPromise ??= (async () => {
    const evidence = process.env.DSH_PHALANX_E2E_EVIDENCE_DIR
    const attempt = async (action: () => unknown | Promise<unknown>) => { try { await action(); return true } catch (error) { cleanupErrors.push(error); return false } }
    if (evidence) await attempt(async () => { await mkdir(evidence, { recursive: true }); await writeFile(join(evidence, 'native-market-phase.json'), JSON.stringify({ phase, at: Date.now(), timeline }) + '\n') })
    // A timed-out browser operation must not keep the installed CLI's shared gateway alive.
    const [, stopped] = await Promise.all([attempt(() => browser.close()), attempt(() => app.stop())])
    const rebuilt = await attempt(() => new CommunityRuntimeDriver(runtime).rebuild())
    if (stopped && rebuilt) await attempt(() => rm(root, { recursive: true, force: true }))
  })()
  onTestFinished(async () => {
    await cleanup()
    if (cleanupErrors.length) throw new AggregateError(cleanupErrors, 'Native market cleanup failed')
  })
  try {
    const origin = await app.start()
    const bootstrap = await admin.request.post(origin + '/bootstrap', { headers: { origin }, form: { credential: readBootstrapCredential(runtime.dataRoot)!.credential, username: 'admin', password: 'password' }, maxRedirects: 0 })
    expect(bootstrap.status()).toBe(303)
    const post = (path: string, data: object) => admin.request.post(origin + '/admin/api/' + path, { headers: { origin }, data })
    expect((await post('accounts', { username: 'member', password: 'password', email: '' })).status()).toBe(201)
    const prepare = async () => {
      mark(phase + ':request')
      expect((await post('plugins', { action: 'add', packageName, version })).status()).toBe(202)
      mark(phase.replace(/:request$/u, ':accepted'))
      let previousStage: string | undefined
      await expect.poll(async () => {
        const row = ((await (await admin.request.get(origin + '/admin/api/plugins')).json()) as CommunityPluginView[])[0]
        if (row?.stage !== previousStage) { previousStage = row?.stage; mark(phase, row?.stage, row?.failureCode) }
        return row?.stage
      }, { timeout: 240000 }).toMatch(/^(available|failed)$/u)
      expect(((await (await admin.request.get(origin + '/admin/api/plugins')).json()) as CommunityPluginView[])[0]).toMatchObject({ stage: 'available', packageName, version })
    }
    mark('initial-preparation'); await prepare()
    expect((await post('plugins/publication', { action: 'publish', packageName, published: true })).status()).toBe(200)
    await signInCommunity(page, origin, 'member', 'password')
    const market = page.getByRole('region', { name: 'Platform App Center', exact: true })
    const openMarket = async () => { await page.getByRole('button', { name: 'Platform App Center', exact: true }).click(); await market.getByRole('heading', { name: packageName, exact: true }).waitFor() }
    const data = async () => (await (await page.request.get(origin + '/market/api/plugins')).json()) as CommunityMarketPageData
    const call = async <T,>(method: string, input: object) => rpc.remoteRpc<T>(origin, await cookieHeader(page.context(), origin), method, input)
    const bundles = () => call<{ name: string, installed: boolean, enabled: boolean, removable: boolean }[]>('pluginManager/listBundles', {})
    const profile = join(runtime.dataRoot, 'users/member/home/.dsh/profiles/web'), manifest = async () => JSON.parse(await readFile(join(profile, 'package.json'), 'utf8'))
    const marketAction = async (label: string) => {
      const accepted = page.waitForResponse(response => response.url().endsWith('/market/api/plugins') && response.request().method() === 'POST')
      await market.getByRole('button', { name: label, exact: true }).click()
      const response = await accepted; expect(response.status()).toBe(202)
      return (await response.json()).job.requestId as string
    }
    const waitJob = async (requestId: string) => {
      await expect.poll(async () => { const job = (await data()).plugins[0]?.job; return job?.requestId === requestId && job.status !== 'running' }, { timeout: 240000 }).toBe(true)
      expect((await data()).plugins[0]?.job?.status, JSON.stringify((await data()).plugins[0]?.job)).toBe('succeeded')
    }
    const restart = async () => { expect((await page.request.post(origin + '/recovery/restart', { headers: { origin }, data: { confirmed: true } })).status()).toBe(200); await signInCommunity(page, origin, 'member', 'password') }
    const waitInstalled = async (requestId: string) => {
      await waitJob(requestId)
      expect((await data()).plugins[0]?.job?.status, JSON.stringify((await data()).plugins[0]?.job)).toBe('succeeded')
      if ((await data()).pending) await restart()
      await expect.poll(async () => (await bundles()).find(row => row.name === packageName)?.installed).toBe(true)
    }
    await openMarket()
    mark('first-native-install')
    const firstInstall = await marketAction('Install')
    await market.getByRole('button', { name: 'Installing…', exact: true }).waitFor()
    await page.getByRole('button', { name: 'Plugins', exact: true }).click() // Stop observing; accepted server work continues.
    await waitInstalled(firstInstall)
    expect((await manifest()).dependencies[packageName]).toMatch(/^file:/u)
    expect(JSON.stringify((await manifest()).dependencies)).not.toContain('plugins.dsh-phalanx.invalid')
    expect((await bundles()).find(row => row.name === packageName)).toMatchObject({ installed: true, removable: true, enabled: true })
    const plugins = await call<{ moduleName: string, fiberPhase: string }[]>('pluginManager/listPlugins', {})
    expect(plugins.some(row => row.moduleName.startsWith(packageName) && row.fiberPhase === 'active')).toBe(true)
    await page.reload(); await page.getByRole('button', { name: 'Plugins', exact: true }).click()
    const card = page.locator(`[data-plugin-package="${packageName}"]`); await card.waitFor()
    mark('native-settings')
    await openNativeSettings(page); await page.getByRole('button', { name: 'Side card', exact: true }).click()
    const setting = page.getByRole('checkbox', { name: 'Inject the sidebar-open tool for the model', exact: true }), before = await setting.isChecked()
    const saved = page.waitForResponse(response => response.url().includes('settings.update') && response.request().method() === 'POST')
    await setting.setChecked(!before); expect((await saved).status()).toBe(200)
    await page.getByRole('button', { name: 'Close', exact: true }).click()
    await openNativeSettings(page); await page.getByRole('button', { name: 'Side card', exact: true }).click(); expect(await setting.isChecked()).toBe(!before)
    await page.reload(); await openNativeSettings(page); await page.getByRole('button', { name: 'Side card', exact: true }).click(); expect(await setting.isChecked()).toBe(!before)
    const evidence = process.env.DSH_PHALANX_E2E_EVIDENCE_DIR
    if (evidence) { await mkdir(evidence, { recursive: true }); await page.screenshot({ path: join(evidence, 'market-native-settings-saved.png'), fullPage: true }) }
    await page.getByRole('button', { name: 'Close', exact: true }).click()
    const dependency = (await manifest()).dependencies[packageName]
    const history = await readFile(join(runtime.dataRoot, 'plugins/installations.json'), 'utf8')
    const retainedCopy = async () => {
      expect((await manifest()).dependencies[packageName]).toBe(dependency)
      expect((await bundles()).find(row => row.name === packageName)).toMatchObject({ installed: true, enabled: true, removable: true })
      expect((await call<{ moduleName: string, fiberPhase: string }[]>('pluginManager/listPlugins', {})).some(row => row.moduleName.startsWith(packageName) && row.fiberPhase === 'active')).toBe(true)
      expect(await readFile(join(runtime.dataRoot, 'plugins/installations.json'), 'utf8')).toBe(history)
      await openNativeSettings(page); await page.getByRole('button', { name: 'Side card', exact: true }).click(); expect(await setting.isChecked()).toBe(!before)
      await page.getByRole('button', { name: 'Close', exact: true }).click()
    }
    mark('shelf-retains-copy')
    expect((await post('plugins/publication', { action: 'publish', packageName, published: false, confirmed: true, selectedMembers: 0 })).status()).toBe(200)
    expect((await data()).plugins).toEqual([]); await retainedCopy(); await restart(); await retainedCopy()
    expect((await post('accounts', { username: 'newcomer', password: 'password', email: '' })).status()).toBe(201)
    const newcomer = await browser.newPage({ locale: 'en' }); await signInCommunity(newcomer, origin, 'newcomer', 'password')
    const unavailableToNewcomer = async () => {
      expect((await (await newcomer.request.get(origin + '/market/api/plugins')).json()).plugins).toEqual([])
      expect((await newcomer.request.post(origin + '/market/api/plugins', { headers: { origin }, data: { action: 'install', packageName, requestId: 'shelf-newcomer' } })).status()).toBe(409)
    }
    await unavailableToNewcomer()
    await newcomer.getByRole('button', { name: 'Platform App Center', exact: true }).click()
    await newcomer.getByRole('region', { name: 'Platform App Center', exact: true }).getByText('No published plugins', { exact: true }).waitFor()
    mark('remove-retains-copy')
    const impact = await (await admin.request.get(origin + '/admin/api/plugins/impact?packageName=' + packageName)).json()
    expect((await post('plugins/change', { action: 'remove', packageName, revision: impact.revision, confirmed: true })).status()).toBe(200)
    expect((await data()).plugins).toEqual([]); await unavailableToNewcomer()
    await retainedCopy(); await restart(); await retainedCopy()
    mark('prepare-again')
    await prepare(); expect((await post('plugins/publication', { action: 'publish', packageName, published: true })).status()).toBe(200)
    expect((await data()).plugins[0]?.status).toBe('installed')
    expect(await call('pluginManager/setBundleEnabled', { name: packageName, enabled: false })).toMatchObject({ application: 'applied' })
    expect((await bundles()).find(row => row.name === packageName)?.enabled).toBe(false)
    expect(await call('pluginManager/setBundleEnabled', { name: packageName, enabled: true })).toMatchObject({ application: 'applied' })
    await openMarket(); await market.getByRole('button', { name: 'Uninstall', exact: true }).waitFor()
    expect(await market.getByText('Platform shared KEY', { exact: true }).count()).toBe(0)
    expect(await market.getByText('Platform controlled, cannot uninstall', { exact: true }).count()).toBe(0)
    mark('market-uninstall')
    const removed = await marketAction('Uninstall'); await waitJob(removed)
    expect((await data()).plugins[0]?.job?.status).toBe('succeeded')
    expect((await manifest()).dependencies?.[packageName]).toBeUndefined()
    expect((await bundles()).some(row => row.name === packageName && row.installed)).toBe(false)
    await page.reload(); await page.getByRole('button', { name: 'Plugins', exact: true }).click()
    await page.locator('[data-plugin-panel][aria-busy="false"]').waitFor(); await page.locator('[data-plugin-loading]').waitFor({ state: 'detached' })
    await page.locator('[data-plugin-group="extensions"] h3').waitFor(); expect(await card.count()).toBe(0)
    mark('second-native-install')
    await openMarket(); const secondInstall = await marketAction('Install'); await waitInstalled(secondInstall)
    await page.reload(); await page.getByRole('button', { name: 'Plugins', exact: true }).click(); await card.waitFor()
    mark('native-uninstall')
    await card.getByRole('button', { name: 'View Better Sidebar', exact: true }).click()
    await page.getByRole('button', { name: 'Uninstall Better Sidebar', exact: true }).click()
    const nativeRemoval = page.waitForResponse(response => response.url().includes('pluginManager/removeBundle') && response.request().method() === 'POST', { timeout: 240000 })
    await page.getByRole('dialog', { name: 'Uninstall "Better Sidebar"?', exact: true }).getByRole('button', { name: 'Uninstall', exact: true }).click()
    const removalResponse = await nativeRemoval; expect(removalResponse.status()).toBe(200)
    expect((await removalResponse.json()).result).toMatchObject({ ok: true, value: { application: 'applied' } })
    await expect.poll(async () => (await bundles()).some(row => row.name === packageName && row.installed), { timeout: 30000 }).toBe(false)
    expect((await manifest()).dependencies?.[packageName]).toBeUndefined()
    await openMarket(); await market.getByRole('button', { name: 'Install', exact: true }).waitFor()
    expect((await data()).plugins[0]?.status).toBe('install')
    expect(errors).toEqual([]); mark('passed')
  } catch (error) { primaryFailure = error }
  finally { await cleanup() }
  if (cleanupErrors.length) throw new AggregateError(primaryFailure === undefined ? cleanupErrors : [primaryFailure, ...cleanupErrors], 'Native market cleanup failed')
  if (primaryFailure !== undefined) throw primaryFailure
}, 600000)
