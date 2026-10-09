import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, writeFile, rm, copyFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { expect, it } from 'vitest'
import { candidateApplication as createCommunityApplication } from './support/candidate-application.js'
import { readBootstrapCredential } from '../src/adapters/bootstrap-credential.js'
import { CommunityRuntimeDriver } from '../src/adapters/community-runtime-driver.js'
import { execFileText } from '../src/adapters/runtime-command.js'
import { runtimeSection, assertPinnedDshRevision } from './support/real-dsh-runtime.js'
import { runtimeSettings } from './support/real-dsh-kit.js'
import { cookieHeader, createRealDshRpc } from './support/real-dsh-rpc.js'
import { signInCommunity } from './fixtures/community-native-browser.js'
import type { CommunityPluginView, CommunityGroupView } from '../src/domain/admin-contract.js'

it.skipIf(!runtimeSettings.containerImage)('loads market choices read-only after restart, follows library versions and restores independent native copies', async () => {
  assertPinnedDshRevision(runtimeSettings)
  const root = await mkdtemp(join(tmpdir(), 'plugin-market-'))
  const runtime = runtimeSection(join(root, 'platform'), 'https://example.test', runtimeSettings)
  const app = createCommunityApplication({ listen: { host: '127.0.0.1', port: 0 }, sessionSecret: 'plugin-market-container-fixture-secret', runtime })
  const browser = await chromium.launch({ headless: true }); const page = await browser.newPage({ locale: 'en' }); page.setDefaultTimeout(30000)
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message))
  const rpc = createRealDshRpc(); let origin = '', admin = ''
  const packageName = '@example/private-market', directory = join(root, 'package')
  const cookies = (response: Response) => response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
  const adminRequest = async (path: string, body?: object) => await fetch(origin + '/admin/api/' + path, {
    method: body ? 'POST' : 'GET', headers: { cookie: admin, origin, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) })
  const pack = async (version: string) => {
    await writeFile(join(directory, 'package.json'), JSON.stringify({ name: packageName, version, description: 'A privately distributed plugin.', type: 'module', main: './index.js', dsh: { bundle: { patch: './patch.yml' } } }))
    await writeFile(join(directory, 'index.js'), `import {writeFileSync} from 'node:fs'; import {join} from 'node:path'; export const name='private-market'; export function apply(){writeFileSync(join(process.env.HOME,'MARKET_PLUGIN_READY'),${JSON.stringify(version)})}`)
    await writeFile(join(directory, 'patch.yml'), JSON.stringify([{ insert: [{ id: 'private-market', name: packageName }] }]))
    const packed = JSON.parse(await execFileText('npm', ['pack', directory, '--ignore-scripts', '--json', '--pack-destination', root])) as Array<{ filename: string }>
    return join(root, packed[0]!.filename)
  }
  const upload = async (version: string, replacement = false) => {
    const archive = await pack(version)
    const result = await fetch(origin + '/admin/api/plugins/upload', { method: 'POST', headers: { cookie: admin, origin, 'content-type': 'application/gzip', 'x-plugin-filename': 'private.tgz', ...(replacement ? { 'x-plugin-replace-package': packageName } : {}) }, body: await readFile(archive) })
    expect(result.status, await result.text()).toBe(202)
    await expect.poll(async () => { const row = (await (await adminRequest('plugins')).json() as CommunityPluginView[])[0]!; return replacement ? row.replacement?.stage : row.stage }, { timeout: 180000 }).toBe('available')
  }
  const call = async <T,>(method: string, input: object) => rpc.remoteRpc<T>(origin, await cookieHeader(page.context(), origin), method, input)
  const inventory = () => call<Array<{ entryId: string, moduleName: string, fiberPhase: string, enabled: boolean, readOnlyReason?: string }>>('pluginManager/listPlugins', {})
  const marker = () => readFile(join(runtime.dataRoot, 'users/member/home/MARKET_PLUGIN_READY'), 'utf8')
  const openMarket = async () => { await signInCommunity(page, origin, 'member', 'password'); await page.getByRole('button', { name: 'Platform apps', exact: true }).click() }
  const market = page.getByRole('region', { name: 'Platform apps', exact: true })
  const restart = async () => {
    await market.getByRole('link', { name: 'Restart DSH instance', exact: true }).click()
    await page.getByRole('checkbox').check(); await page.getByRole('button', { name: 'Restart instance', exact: true }).click()
    await page.getByText('Instance restarted. Your saved data is ready.', { exact: true }).waitFor({ timeout: 90000 })
    await openMarket()
  }
  try {
    origin = await app.start(); await mkdir(directory)
    const response = await fetch(origin + '/bootstrap', { method: 'POST', redirect: 'manual', headers: { origin, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ credential: readBootstrapCredential(runtime.dataRoot)!.credential, username: 'admin', password: 'password' }) })
    admin = cookies(response); expect(response.status).toBe(303)
    expect((await adminRequest('accounts', { username: 'member', password: 'password', email: '' })).status).toBe(201)
    await upload('1.0.0'); await openMarket()
    await market.getByText('No published plugins', { exact: true }).waitFor()
    expect((await adminRequest('plugins/publication', { action: 'publish', packageName, published: true })).status).toBe(200)
    await market.getByRole('button', { name: 'Install', exact: true }).click()
    await market.getByText('Installed (platform app center)', { exact: true }).waitFor()
    await expect(marker()).rejects.toMatchObject({ code: 'ENOENT' })
    await restart(); expect(await marker()).toBe('1.0.0')
    const own = (await inventory()).find(row => row.moduleName.includes('/node_modules/' + packageName))!
    expect(own).toBeDefined(); expect(own).toMatchObject({ fiberPhase: 'active', readOnlyReason: 'unaddressable' })
    expect(await call('pluginManager/setPluginEnabled', { id: own.entryId, enabled: false })).toMatchObject({ application: 'failed', changed: false })
    expect(await call('pluginManager/removeBundle', { name: own.moduleName })).toMatchObject({ application: 'failed' })
    const owner = createHash('sha256').update(runtime.dataRoot).digest('hex')
    const carrier = (await execFileText('podman', ['ps', '--filter', `label=dsh-phalanx.community-root=${owner}`, '--format', '{{.Names}}'])).trim()
    const readonly = await execFileText('podman', ['exec', carrier, 'node', '-e', `try { require('node:fs').appendFileSync(${JSON.stringify(own.moduleName)}, ''); process.stdout.write('writable') } catch(error) { process.stdout.write(error.code) }`])
    expect(readonly).toBe('EROFS')
    const nativeManifest = await readFile(join(runtime.dataRoot, 'users/member/home/.dsh/profiles/web/package.json'), 'utf8')
    expect(nativeManifest).not.toContain(packageName)
    const older = await pack('0.9.0'); await copyFile(older, join(runtime.dataRoot, 'users/member/home/older.tgz'))
    expect(await call('pluginManager/installBundle', { spec: '/dsh-phalanx/home/older.tgz' })).toMatchObject({ changed: true })
    expect((await page.request.post(origin + '/recovery/restart', { headers: { origin }, data: { confirmed: true } })).status()).toBe(200)
    await openMarket(); expect(await marker()).toBe('1.0.0')
    expect((await inventory()).find(row => row.moduleName === packageName)?.enabled).toBe(false)
    const groups = await (await adminRequest('groups')).json() as CommunityGroupView[]
    const group = groups.find(row => row.isDefault)!
    await adminRequest(`groups/${group.id}/plugins`, { action: 'save', packages: [packageName] })
    await market.getByRole('button', { name: 'Reload plugins', exact: true }).click()
    await market.getByText('Installed (platform preinstalled)', { exact: true }).waitFor()
    expect(await market.getByRole('button', { name: 'Installed', exact: true }).isDisabled()).toBe(true)
    await adminRequest(`groups/${group.id}/plugins`, { action: 'save', packages: [] })
    await upload('2.0.0', true)
    const impact = await (await adminRequest('plugins/impact?packageName=' + encodeURIComponent(packageName))).json() as { revision: string }
    expect((await adminRequest('plugins/change', { action: 'select', packageName, revision: impact.revision, confirmed: true })).status).toBe(200)
    await market.getByRole('button', { name: 'Reload plugins', exact: true }).click()
    await market.getByText('Version 2.0.0', { exact: true }).waitFor(); await restart(); expect(await marker()).toBe('2.0.0')
    await market.getByRole('button', { name: 'Uninstall', exact: true }).click(); await restart()
    expect(await marker()).toBe('0.9.0')
    await market.getByText('Installed on the native plugin page', { exact: true }).waitFor()
    expect((await inventory()).find(row => row.moduleName === packageName)?.fiberPhase).toBe('active')
    expect((await inventory()).some(row => row.moduleName.includes('/node_modules/' + packageName))).toBe(false)
    expect((await adminRequest('plugins/publication', { action: 'publish', packageName, published: false, confirmed: true, selectedMembers: 0 })).status).toBe(200)
    await market.getByText('No published plugins', { exact: true }).waitFor()
    expect((await call<Array<{ name: string, installed: boolean }>>('pluginManager/listBundles', {})).find(row => row.name === packageName)?.installed).toBe(true)
    await adminRequest('plugins/publication', { action: 'publish', packageName, published: true })
    await market.getByText('Installed on the native plugin page', { exact: true }).waitFor()
    const evidence = process.env.DSH_PHALANX_E2E_EVIDENCE_DIR
    if (evidence) { await mkdir(evidence, { recursive: true }); await page.screenshot({ path: join(evidence, 'native-market-selection.png'), animations: 'disabled', fullPage: true }) }
    expect(errors).toEqual([])
  } finally { await browser.close(); await app.stop(); await new CommunityRuntimeDriver(runtime).rebuild(); await rm(root, { recursive: true, force: true }) }
}, 360000)
