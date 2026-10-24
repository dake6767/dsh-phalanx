// Validation: T2; real credentials: none; actual Linux rootless DSH. Missing inputs must fail the T2 report gate.
import { createHash } from 'node:crypto'
import { execFileText } from '../src/adapters/runtime-command.js'
import { coordinationPackage, packCoordinationPlugin } from './fixtures/coordination-plugin.js'
import { mkdtemp, readFile, rm, copyFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { expect, it } from 'vitest'
import { candidateApplication as createCommunityApplication } from './support/candidate-application.js'
import { readBootstrapCredential } from '../src/adapters/bootstrap-credential.js'
import { CommunityRuntimeDriver } from '../src/adapters/community-runtime-driver.js'
import { runtimeSection, assertPinnedDshRevision } from './support/real-dsh-runtime.js'
import { runtimeSettings } from './support/real-dsh-kit.js'
import { cookieHeader, createRealDshRpc, rpcBody } from './support/real-dsh-rpc.js'
import { signInCommunity } from './fixtures/community-native-browser.js'
import { communityEntryUrl } from './support/community-space.js'
import type { CommunityGroupView, CommunityPluginView, CommunityMarketPageData } from '../src/domain/admin-contract.js'

it.skipIf(!runtimeSettings.containerImage)('lets only the maintainer switch a native copy while another member keeps platform code and credentials', async () => {
  assertPinnedDshRevision(runtimeSettings)
  const root = await mkdtemp(join(tmpdir(), 'plugin-maintainer-local-'))
  const runtime = runtimeSection(join(root, 'platform'), 'https://example.test', runtimeSettings)
  const app = createCommunityApplication({ listen: { host: '127.0.0.1', port: 0 }, sessionSecret: 'plugin-coordination-container-fixture-secret', runtime, network: { hostPublicAddresses: process.env.DSH_PHALANX_E2E_HOST_PUBLIC_ADDRESSES?.split(',') ?? [] } })
  const browser = await chromium.launch({ headless: true }); const page = await browser.newPage({ locale: 'en' })
  page.setDefaultTimeout(60000)
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message))
  const rpc = createRealDshRpc(); let origin = ''; let admin = ''; let member = ''
  const cookies = (response: Response) => response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
  const adminRequest = async (path: string, body?: object) => await fetch(origin + '/admin/api/' + path, {
    method: body ? 'POST' : 'GET', headers: { cookie: admin, origin, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) })
  const memberRequest = async (path: string, body?: object) => await fetch(origin + path, {
    method: body ? 'POST' : 'GET', headers: { cookie: member, origin, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) })
  const signIn = async () => { await signInCommunity(page, origin, 'member', 'password'); member = await cookieHeader(page.context(), origin) }
  const inventory = async () => await rpc.remoteRpc<Array<{ entryId: string, moduleName: string, enabled: boolean, fiberPhase: string }>>(origin, member, 'pluginManager/listPlugins', {})
  const market = async () => await (await memberRequest('/market/api/plugins')).json() as CommunityMarketPageData
  const restart = async () => { expect((await memberRequest('/recovery/restart', { confirmed: true })).status).toBe(200); await signIn() }
  const checkSidebar = async (managed: boolean) => {
    await page.locator('[data-coordination-client]').waitFor({ state: 'attached' })
    expect(await page.locator('[data-coordination-client]').count()).toBe(1)
    const rows = (await inventory()).filter(row => row.moduleName.includes(coordinationPackage))
    expect(rows.filter(row => row.enabled && row.fiberPhase === 'active')).toHaveLength(1)
    expect(rows.find(row => row.enabled)?.moduleName.includes('/dsh-phalanx/artifacts/')).toBe(managed)
    expect(await market()).toMatchObject({ pending: false, plugins: [{ packageName: coordinationPackage, status: managed ? 'managed' : 'native' }] })
    expect(errors).toEqual([])
  }
  try {
    origin = await app.start()
    const response = await fetch(origin + '/bootstrap', { method: 'POST', redirect: 'manual', headers: { origin, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ credential: readBootstrapCredential(runtime.dataRoot)!.credential, username: 'admin', password: 'password' }) })
    admin = cookies(response); expect(response.status).toBe(303)
    const groups = await (await adminRequest('groups')).json() as CommunityGroupView[]; const group = groups.find(row => row.isDefault)!
    expect((await adminRequest('accounts', { username: 'member', password: 'password', email: '', groupId: group.id })).status).toBe(201)
    const archive = await packCoordinationPlugin(root)
    const uploaded = await fetch(origin + '/admin/api/plugins/upload', { method: 'POST', headers: { cookie: admin, origin, 'content-type': 'application/gzip', 'x-plugin-filename': 'client.tgz' }, body: await readFile(archive) })
    expect(uploaded.status).toBe(202)
    await expect.poll(async () => (await (await adminRequest('plugins')).json() as CommunityPluginView[])[0]?.stage, { timeout: 240000 }).toMatch(/^(available|failed)$/u)
    expect((await (await adminRequest('plugins')).json() as CommunityPluginView[])[0]).toMatchObject({ stage: 'available' })
    const packageQuery = '?packageName=' + encodeURIComponent(coordinationPackage)
    expect((await adminRequest('plugins/upstreams' + packageQuery, { action: 'save', upstream: { name: 'search', baseUrl: 'https://provider.example', headers: [{ name: 'Authorization', value: 'Bearer {credential}' }], credential: 'local-copy-platform-fixture-secret' } })).status).toBe(200)
    expect((await adminRequest('plugins/access' + packageQuery, { environment: [{ name: 'LOCAL_COPY_PLATFORM_TOKEN', value: '{access-token}' }], entriesYaml: '' })).status).toBe(200)
    expect((await adminRequest('plugins/publication', { action: 'publish', packageName: coordinationPackage, published: true, confirmed: true })).status).toBe(200)
    await signIn()
    // This independent native copy can yield to the explicit group grant or shared-key selection.
    // Package installation can exceed the ordinary RPC helper's retry deadline.
    const installRpc = createRealDshRpc('', (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(240_000) }))
    await copyFile(archive, join(runtime.dataRoot, 'users/member/home/client.tgz'))
    const installed = await installRpc.remoteRpc(origin, member, 'pluginManager/installBundle', { spec: '/dsh-phalanx/home/client.tgz' })
    expect(installed, JSON.stringify(installed)).toMatchObject({ changed: true })
    await restart(); await checkSidebar(false)
    const profile = join(runtime.dataRoot, 'users/member/home/.dsh/profiles/web')
    const original = await readFile(join(profile, 'node_modules/' + coordinationPackage + '/package.json'), 'utf8')
    const endpoint = `groups/${group.id}/plugins`
    await adminRequest(endpoint, { action: 'save', packages: [coordinationPackage], preinstalls: [], revision: (await (await adminRequest(endpoint)).json()).revision })
    expect(await market()).toMatchObject({ pending: true, plugins: [{ packageName: coordinationPackage, status: 'managed' }] })
    await restart(); await checkSidebar(true)
    expect((await memberRequest('/market/api/plugins', { packageName: coordinationPackage })).status).toBe(409)
    expect(await readFile(join(profile, 'cordis.patch.yml'), 'utf8')).toContain('phalanx-managed-yield')

    const maintenance = (await (await adminRequest('plugins')).json() as CommunityPluginView[]).find(row => row.packageName === coordinationPackage)!
    expect((await adminRequest('plugins/maintainer?packageName=' + encodeURIComponent(coordinationPackage), { username: 'member', revision: maintenance.maintenanceRevision })).status).toBe(200)
    expect((await adminRequest('accounts', { username: 'other', password: 'password', email: '', groupId: group.id })).status).toBe(201)
    const other = await browser.newPage({ locale: 'en' }); await signInCommunity(other, origin, 'other', 'password')
    const otherCookie = await cookieHeader(other.context(), origin)
    const otherInventory = () => rpc.remoteRpc<Array<{ moduleName: string, enabled: boolean, fiberPhase: string }>>(origin, otherCookie, 'pluginManager/listPlugins', {})
    const checkOther = async () => { const active = (await otherInventory()).filter(row => row.moduleName.includes(coordinationPackage) && row.enabled && row.fiberPhase === 'active'); expect(active).toHaveLength(1); expect(active[0]?.moduleName).toContain('/dsh-phalanx/artifacts/') }
    await checkOther()
    const instanceCommand = async (script: string) => {
      const ownership = createHash('sha256').update(runtime.dataRoot).digest('hex')
      const container = (await execFileText(runtimeSettings.containerRuntimeCli, ['ps', '--filter', 'label=dsh-phalanx.community-root=' + ownership, '--filter', 'label=dsh-phalanx.user=member', '--format', '{{.Names}}'])).trim()
      return execFileText(runtimeSettings.containerRuntimeCli, ['exec', container, 'node', '-e', script])
    }
    const hasConfiguration = () => instanceCommand('console.log(process.env.LOCAL_COPY_PLATFORM_TOKEN ? "HAS_PLATFORM_CONFIG" : "NO_PLATFORM_CONFIG")')
    expect(await hasConfiguration()).toContain('HAS_PLATFORM_CONFIG')
    const details = '/market/api/plugins/contribution?packageName=' + encodeURIComponent(coordinationPackage)
    expect(await (await memberRequest(details)).json()).toMatchObject({ canMaintain: true, localCopy: { enabled: false, application: 'applied' } })
    const denied = await fetch(origin + '/market/api/plugins/local-copy', { method: 'POST', headers: { cookie: otherCookie, origin, 'content-type': 'application/json' }, body: JSON.stringify({ packageName: coordinationPackage, enabled: true }) })
    expect(denied.status).toBe(403)
    const open = async () => { await page.getByRole('button', { name: 'Plugins', exact: true }).click(); await page.getByRole('button', { name: new RegExp(coordinationPackage.replace('/', '\\/')) }).first().click(); await page.getByRole('switch', { name: 'Use my local copy', exact: true }).waitFor() }
    await open()
    expect(await page.getByRole('region', { name: 'Plugin contribution', exact: true }).innerText()).toContain('no platform credentials')
    await page.getByRole('switch', { name: 'Use my local copy', exact: true }).click()
    await expect.poll(async () => (await (await memberRequest(details)).json()).localCopy).toEqual({ enabled: true, application: 'restart-required' })
    expect((await (await adminRequest(endpoint)).json()).pendingMembers).toEqual(['member'])
    await checkOther(); await restart()
    await page.locator('[data-coordination-client]').waitFor({ state: 'attached' })
    const localRows = (await inventory()).filter(row => row.moduleName.includes(coordinationPackage) && row.enabled && row.fiberPhase === 'active')
    expect(localRows).toHaveLength(1); expect(localRows[0]?.moduleName).not.toContain('/dsh-phalanx/artifacts/')
    expect(await readFile(join(profile, 'cordis.patch.yml'), 'utf8')).not.toContain('phalanx-managed-yield')
    expect(await readFile(join(profile, 'node_modules/' + coordinationPackage + '/package.json'), 'utf8')).toBe(original)
    expect(await hasConfiguration()).toContain('NO_PLATFORM_CONFIG')
    const deniedGateway = await instanceCommand('fetch(new URL("/plugins/' + encodeURIComponent(coordinationPackage) + '/search",process.env.DSH_PHALANX_MODEL_GATEWAY_URL),{headers:{authorization:"Bearer "+process.env.DSH_PHALANX_MODEL_GATEWAY_ACCESS_TOKEN}}).then(r=>console.log(r.status))')
    expect(deniedGateway.trim()).toBe('403')
    expect((await (await adminRequest(endpoint)).json()).pendingMembers).toEqual([])
    await checkOther(); await open()
    const evidence = process.env.DSH_PHALANX_E2E_EVIDENCE_DIR
    if (evidence) await page.screenshot({ path: join(evidence, 'maintainer-local-copy.png'), fullPage: true, animations: 'disabled' })
    await page.getByRole('switch', { name: 'Use my local copy', exact: true }).click()
    await expect.poll(async () => (await (await memberRequest(details)).json()).localCopy).toEqual({ enabled: false, application: 'restart-required' })
    expect((await instanceCommand('fetch(new URL("/plugins/' + encodeURIComponent(coordinationPackage) + '/search",process.env.DSH_PHALANX_MODEL_GATEWAY_URL),{headers:{authorization:"Bearer "+process.env.DSH_PHALANX_MODEL_GATEWAY_ACCESS_TOKEN}}).then(r=>console.log(r.status))')).trim()).toBe('403')
    await restart(); await checkSidebar(true); await checkOther(); expect(await hasConfiguration()).toContain('HAS_PLATFORM_CONFIG'); await open()
    if (evidence) await page.screenshot({ path: join(evidence, 'maintainer-platform-copy.png'), fullPage: true, animations: 'disabled' })
    await page.getByRole('switch', { name: 'Use my local copy', exact: true }).click()
    await expect.poll(async () => (await (await memberRequest(details)).json()).localCopy?.enabled).toBe(true)
    expect((await adminRequest(endpoint, { action: 'save', packages: [], preinstalls: [], revision: (await (await adminRequest(endpoint)).json()).revision })).status).toBe(200)
    expect((await adminRequest('plugins/upstreams' + packageQuery, { action: 'save', upstream: { name: 'search', baseUrl: 'https://provider.example', headers: [{ name: 'Authorization', value: 'Bearer {credential}' }], credential: '' } })).status).toBe(200)
    expect(await (await memberRequest(details)).json()).toMatchObject({ canMaintain: true })
    expect((await (await memberRequest(details)).json()).localCopy).toBeUndefined()
    expect((await memberRequest('/market/api/plugins/local-copy', { packageName: coordinationPackage, enabled: false })).status).toBe(403)
    await restart(); await checkSidebar(false); expect(await hasConfiguration()).toContain('NO_PLATFORM_CONFIG')
    await page.getByRole('button', { name: 'Plugins', exact: true }).click()
    const loadedDetails = page.waitForResponse(response => response.url().includes('/market/api/plugins/contribution?') && response.status() === 200)
    await page.getByRole('button', { name: new RegExp(coordinationPackage.replace('/', '\\/')) }).first().click()
    await loadedDetails; await page.getByRole('button', { name: 'Contribute to platform', exact: true }).waitFor()
    expect(await page.getByRole('switch', { name: 'Use my local copy', exact: true }).count()).toBe(0)


  } catch (error) {
    const evidence = process.env.DSH_PHALANX_E2E_EVIDENCE_DIR
    if (evidence) await Promise.allSettled([
      page.screenshot({ path: join(evidence, 'maintainer-failure.png'), fullPage: true, animations: 'disabled', timeout: 5000 }),
      (async () => {
        const panel = await page.evaluate(() => ({
          buttons: Array.from(document.querySelectorAll('button')).map(button => ({ text: button.textContent, current: button.getAttribute('aria-current') })),
          tabs: Array.from(document.querySelectorAll('[role="tab"]')).map(tab => ({ text: tab.textContent, selected: tab.getAttribute('aria-selected') })),
          packages: Array.from(document.querySelectorAll('[data-plugin-package]')).map(row => row.getAttribute('data-plugin-package')),
          details: Array.from(document.querySelectorAll('[data-plugin-detail]')).map(row => row.getAttribute('data-plugin-detail')),
          loading: document.querySelectorAll('[data-plugin-loading]').length,
        }))
        await writeFile(join(evidence, 'maintainer-failure-panel.json'), JSON.stringify({ url: page.url(), errors, panel }) + '\n')
      })(),
      (async () => {
        const diagnosticRpc = async <T,>(endpoint: string): Promise<T> => {
          const response = await fetch(new URL(`api/${endpoint}`, `${communityEntryUrl(origin, member).replace(/\/$/u, '')}/`), {
            method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/json', cookie: member }, body: rpcBody(endpoint, {}), signal: AbortSignal.timeout(5000),
          })
          if (!response.ok) throw new Error('Diagnostic RPC unavailable')
          const body = await response.json() as { result: { ok: boolean, value: T } }
          if (!body.result.ok) throw new Error('Diagnostic RPC rejected')
          return body.result.value
        }
        const methods = await Promise.allSettled([
          diagnosticRpc<Array<{ name: string, installed: boolean, enabled: boolean, availability: string, official: boolean, error?: { code: string }, rows: { rowId: string, moduleName: string, entryId: string }[] }>>('pluginManager/listBundles').then(rows => rows.filter(row => row.name === coordinationPackage).map(({ name, installed, enabled, availability, official, error, rows }) => ({ name, installed, enabled, availability, official, error: error ? { code: error.code } : undefined, rows: rows.map(({ rowId, moduleName, entryId }) => ({ rowId, moduleName, entryId })) }))),
          diagnosticRpc<Array<{ entryId: string, moduleName: string, enabled: boolean, fiberPhase: string }>>('pluginManager/listPlugins').then(rows => rows.filter(row => row.moduleName.includes(coordinationPackage)).map(({ entryId, moduleName, enabled, fiberPhase }) => ({ entryId, moduleName, enabled, fiberPhase }))),
        ])
        await writeFile(join(evidence, 'maintainer-failure-packages.json'), JSON.stringify(methods.map((result, index) => result.status === 'fulfilled' ? { method: index === 0 ? 'listBundles' : 'listPlugins', status: result.status, rows: result.value } : { method: index === 0 ? 'listBundles' : 'listPlugins', status: result.status, error: result.reason instanceof Error ? result.reason.name : typeof result.reason })) + '\n')
      })(),
    ])
    throw error
  } finally { await browser.close(); await app.stop(); await new CommunityRuntimeDriver(runtime).rebuild(); await rm(root, { recursive: true, force: true }) }
}, 420000)
