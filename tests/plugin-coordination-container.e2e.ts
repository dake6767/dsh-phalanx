import { mkdtemp, readFile, rm } from 'node:fs/promises'
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
import type { CommunityGroupView, CommunityPluginView, CommunityMarketPluginView } from '../src/domain/admin-contract.js'

it.skipIf(!runtimeSettings.containerImage)('coordinates real sidebar self-install, grant, revoke and group transfer without duplicate clients', async () => {
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
  const restart = async () => { expect((await memberRequest('/recovery/restart', { confirmed: true })).status).toBe(200); await signIn() }
  const checkSidebar = async (managed: boolean) => {
    await page.locator('[data-dsh-better-sidebar]').waitFor({ state: 'attached' })
    const rows = (await inventory()).filter(row => row.moduleName.includes('dsh-better-sidebar'))
    expect(rows.filter(row => row.enabled && row.fiberPhase === 'active')).toHaveLength(1)
    expect(rows.find(row => row.enabled)?.moduleName.includes('/dsh-phalanx/artifacts/')).toBe(managed)
    expect(errors).toEqual([])
  }
  try {
    origin = await app.start()
    const response = await fetch(origin + '/bootstrap', { method: 'POST', redirect: 'manual', headers: { origin, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ credential: readBootstrapCredential(runtime.dataRoot)!.credential, username: 'admin', password: 'password' }) })
    admin = cookies(response); expect(response.status).toBe(303)
    const groups = await (await adminRequest('groups')).json() as CommunityGroupView[]; const group = groups.find(row => row.isDefault)!
    expect((await adminRequest('accounts', { username: 'member', password: 'password', email: '', groupId: group.id })).status).toBe(201)
    expect((await adminRequest('plugins', { action: 'add', packageName: 'dsh-better-sidebar', version: '0.24.1' })).status).toBe(202)
    await expect.poll(async () => (await (await adminRequest('plugins')).json() as CommunityPluginView[])[0]?.stage, { timeout: 240000 }).toBe('available')
    expect((await adminRequest('plugins/publication', { action: 'publish', packageName: 'dsh-better-sidebar', published: true })).status).toBe(200)
    await signIn()
    const install = await memberRequest('/market/api/plugins', { packageName: 'dsh-better-sidebar' })
    expect(install.status, await install.text()).toBe(200)
    await page.reload(); await checkSidebar(false)
    const profile = join(runtime.dataRoot, 'users/member/home/.dsh/profiles/web')
    const original = await readFile(join(profile, 'node_modules/dsh-better-sidebar/package.json'), 'utf8')
    const endpoint = `groups/${group.id}/plugins`
    await adminRequest(endpoint, { action: 'save', packages: ['dsh-better-sidebar'] })
    expect(((await (await memberRequest('/market/api/plugins')).json()) as CommunityMarketPluginView[])[0]?.status).toBe('installed')
    await restart(); await checkSidebar(true)
    expect((await memberRequest('/market/api/plugins', { packageName: 'dsh-better-sidebar' })).status).toBe(409)
    expect(await readFile(join(profile, 'cordis.patch.yml'), 'utf8')).toContain('phalanx-managed-yield')
    await adminRequest(endpoint, { action: 'save', packages: [] })
    expect((await memberRequest('/market/api/plugins', { packageName: 'dsh-better-sidebar' })).status).toBe(409)
    await restart(); await checkSidebar(false)
    expect(await readFile(join(profile, 'cordis.patch.yml'), 'utf8')).not.toContain('phalanx-managed-yield')
    expect(await readFile(join(profile, 'node_modules/dsh-better-sidebar/package.json'), 'utf8')).toBe(original)
    await adminRequest(endpoint, { action: 'save', packages: ['dsh-better-sidebar'] })
    await restart(); await checkSidebar(true)
    const created = await adminRequest('groups', { action: 'create', name: 'Without plugins' })
    expect(created.status).toBe(200)
    const refreshed = await (await adminRequest('groups')).json() as CommunityGroupView[]
    const destination = refreshed.find(row => row.name === 'Without plugins')!
    expect((await adminRequest('accounts/member/actions', { action: 'set-email', email: '', groupId: destination.id })).status).toBe(200)
    await restart(); await checkSidebar(false)
  } finally { await browser.close(); await app.stop(); await new CommunityRuntimeDriver(runtime).rebuild(); await rm(root, { recursive: true, force: true }) }
}, 420000)
