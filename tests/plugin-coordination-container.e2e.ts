// Validation: T2; real credentials: none; actual Linux rootless DSH. Missing inputs must fail the T2 report gate.
import { coordinationPackage, packCoordinationPlugin } from './fixtures/coordination-plugin.js'
import { mkdtemp, readFile, rm, copyFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { expect, it } from 'vitest'
import { candidateApplication as createCommunityApplication } from './support/candidate-application.js'
import { readBootstrapCredential } from '../src/adapters/bootstrap-credential.js'
import { CommunityRuntimeDriver } from '../src/adapters/community-runtime-driver.js'
import { runtimeSection, assertPinnedDshRevision } from './support/real-dsh-runtime.js'
import { runtimeSettings } from './support/real-dsh-kit.js'
import { cookieHeader, createRealDshRpc } from './support/real-dsh-rpc.js'
import { signInCommunity } from './fixtures/community-native-browser.js'
import type { CommunityGroupView, CommunityPluginView, CommunityMarketPageData } from '../src/domain/admin-contract.js'

it.skipIf(!runtimeSettings.containerImage)('coordinates real client self-install, grant, revoke and group transfer without duplicate clients', async () => {
  assertPinnedDshRevision(runtimeSettings)
  const root = await mkdtemp(join(tmpdir(), 'plugin-coordination-'))
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
    expect((await adminRequest('plugins/publication', { action: 'publish', packageName: coordinationPackage, published: true })).status).toBe(200)
    await signIn()
    // This scenario needs an independent native copy; a platform-app choice loads read-only after restart.
    // Package installation can exceed the ordinary RPC helper's retry deadline.
    const installRpc = createRealDshRpc('', (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(240_000) }))
    await copyFile(archive, join(runtime.dataRoot, 'users/member/home/client.tgz'))
    const installed = await installRpc.remoteRpc(origin, member, 'pluginManager/installBundle', { spec: '/dsh-phalanx/home/client.tgz' })
    expect(installed, JSON.stringify(installed)).toMatchObject({ changed: true })
    await restart(); await checkSidebar(false)
    const profile = join(runtime.dataRoot, 'users/member/home/.dsh/profiles/web')
    const original = await readFile(join(profile, 'node_modules/' + coordinationPackage + '/package.json'), 'utf8')
    const endpoint = `groups/${group.id}/plugins`
    await adminRequest(endpoint, { action: 'save', packages: [coordinationPackage] })
    expect(await market()).toMatchObject({ pending: true, plugins: [{ packageName: coordinationPackage, status: 'managed' }] })
    await restart(); await checkSidebar(true)
    expect((await memberRequest('/market/api/plugins', { packageName: coordinationPackage })).status).toBe(409)
    expect(await readFile(join(profile, 'cordis.patch.yml'), 'utf8')).toContain('phalanx-managed-yield')
    await adminRequest(endpoint, { action: 'save', packages: [] })
    expect((await memberRequest('/market/api/plugins', { packageName: coordinationPackage })).status).toBe(409)
    await restart(); await checkSidebar(false)
    expect(await readFile(join(profile, 'cordis.patch.yml'), 'utf8')).not.toContain('phalanx-managed-yield')
    expect(await readFile(join(profile, 'node_modules/' + coordinationPackage + '/package.json'), 'utf8')).toBe(original)
    await adminRequest(endpoint, { action: 'save', packages: [coordinationPackage] })
    await restart(); await checkSidebar(true)
    const created = await adminRequest('groups', { action: 'create', name: 'Without plugins' })
    expect(created.status).toBe(200)
    const refreshed = await (await adminRequest('groups')).json() as CommunityGroupView[]
    const destination = refreshed.find(row => row.name === 'Without plugins')!
    expect((await adminRequest('accounts/member/actions', { action: 'set-email', email: '', groupId: destination.id })).status).toBe(200)
    await restart(); await checkSidebar(false)
  } finally { await browser.close(); await app.stop(); await new CommunityRuntimeDriver(runtime).rebuild(); await rm(root, { recursive: true, force: true }) }
}, 420000)
