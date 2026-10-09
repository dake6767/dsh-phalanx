import { mkdtemp, mkdir, readFile, writeFile, rm, copyFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { expect, it } from 'vitest'
import { createCommunityApplication } from '../src/composition/community-application.js'
import { readBootstrapCredential } from '../src/adapters/bootstrap-credential.js'
import { CommunityRuntimeDriver } from '../src/adapters/community-runtime-driver.js'
import { execFileText } from '../src/adapters/runtime-command.js'
import { runtimeSection, assertPinnedDshRevision } from './support/real-dsh-runtime.js'
import { runtimeSettings } from './support/real-dsh-kit.js'
import { cookieHeader, createRealDshRpc } from './support/real-dsh-rpc.js'
import { signInCommunity } from './fixtures/community-native-browser.js'
import type { CommunityPluginView } from '../src/domain/admin-contract.js'

it.skipIf(!runtimeSettings.containerImage)('installs a private published archive from the native sidebar into the member profile', async () => {
  assertPinnedDshRevision(runtimeSettings)
  const root = await mkdtemp(join(tmpdir(), 'plugin-market-'))
  const runtime = runtimeSection(join(root, 'platform'), 'https://example.test', runtimeSettings)
  const app = createCommunityApplication({ listen: { host: '127.0.0.1', port: 0 }, sessionSecret: 'plugin-market-container-fixture-secret', runtime })
  const browser = await chromium.launch({ headless: true }); const page = await browser.newPage({ locale: 'en' })
  page.setDefaultTimeout(30000)
  page.on('pageerror', error => console.error('browser error', error.message))
  const rpc = createRealDshRpc(); let origin = ''; let admin = ''
  const cookies = (response: Response) => response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
  const adminRequest = async (path: string, body?: object) => await fetch(origin + '/admin/api/' + path, {
    method: body ? 'POST' : 'GET', headers: { cookie: admin, origin, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) })
  try {
    origin = await app.start()
    const response = await fetch(origin + '/bootstrap', { method: 'POST', redirect: 'manual', headers: { origin, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ credential: readBootstrapCredential(runtime.dataRoot)!.credential, username: 'admin', password: 'password' }) })
    admin = cookies(response); expect(response.status).toBe(303)
    expect((await adminRequest('accounts', { username: 'member', password: 'password', email: '' })).status).toBe(201)
    const directory = join(root, 'package'); await mkdir(directory)
    await writeFile(join(directory, 'package.json'), JSON.stringify({ name: '@example/private-market', version: '1.0.0', description: 'A privately distributed plugin.', type: 'module', main: './index.js', dsh: { bundle: { patch: './patch.yml' } } }))
    // Precheck has no member home; use the standard HOME location for the activation proof.
    await writeFile(join(directory, 'index.js'), "import {writeFileSync} from 'node:fs'; import {join} from 'node:path'; export const name='private-market'; export function apply(){writeFileSync(join(process.env.HOME,'MARKET_PLUGIN_READY'),'1.0.0')} ")
    await writeFile(join(directory, 'patch.yml'), JSON.stringify([{ insert: [{ id: 'private-market', name: '@example/private-market' }] }]))
    const packed = JSON.parse(await execFileText('npm', ['pack', directory, '--ignore-scripts', '--json', '--pack-destination', root])) as Array<{ filename: string }>
    const uploaded = await fetch(origin + '/admin/api/plugins/upload', { method: 'POST', headers: { cookie: admin, origin, 'content-type': 'application/gzip', 'x-plugin-filename': 'private.tgz' }, body: await readFile(join(root, packed[0]!.filename)) })
    expect(uploaded.status).toBe(202)
    await expect.poll(async () => (await (await adminRequest('plugins')).json() as CommunityPluginView[])[0]?.stage, { timeout: 180000 }).toBe('available')
    await signInCommunity(page, origin, 'member', 'password')
    await page.getByRole('button', { name: 'Platform plugin marketplace', exact: true }).click()
    const market = page.frameLocator('iframe[title="Platform plugin marketplace"]')
    await market.getByText('No published plugins', { exact: true }).waitFor()
    expect((await adminRequest('plugins/publication', { action: 'publish', packageName: '@example/private-market', published: true })).status).toBe(200)
    const installation = page.waitForResponse(response => new URL(response.url()).pathname === '/market/api/plugins' && response.request().method() === 'POST', { timeout: 130000 })
    await market.getByRole('button', { name: 'Install', exact: true }).click()
    const installedResponse = await installation
    expect(installedResponse.status(), await installedResponse.text()).toBe(200)
    await market.getByRole('button', { name: 'Installed', exact: true }).waitFor({ timeout: 120000 })
    expect(await readFile(join(runtime.dataRoot, 'users/member/home/MARKET_PLUGIN_READY'), 'utf8')).toBe('1.0.0')
    await page.getByRole('button', { name: 'Plugins', exact: true }).click()
    await page.getByText('Installed', { exact: true }).first().waitFor()
    await page.getByText('@example/private-market', { exact: true }).first().waitFor()
    await page.getByRole('button', { name: 'Platform plugin marketplace', exact: true }).click()
    expect(await readFile(join(runtime.dataRoot, 'users/member/home/.dsh/profiles/web/package.json'), 'utf8')).not.toContain('plugins.dsh-phalanx.invalid')
    const cookie = await cookieHeader(page.context(), origin)
    const bundles = await rpc.remoteRpc<Array<{ name: string, version: string, installed: boolean }>>(origin, cookie, 'pluginManager/listBundles', {})
    expect(bundles.find(row => row.name === '@example/private-market')).toMatchObject({ version: '1.0.0', installed: true })
    const plugins = await rpc.remoteRpc<Array<{ entryId: string, moduleName: string, readOnlyReason?: string }>>(origin, cookie, 'pluginManager/listPlugins', {})
    const own = plugins.find(row => row.moduleName === '@example/private-market')!
    expect(own).toBeDefined(); expect(own.readOnlyReason).toBeUndefined()
    expect(await rpc.remoteRpc(origin, cookie, 'pluginManager/setPluginEnabled', { id: own.entryId, enabled: false })).toMatchObject({ changed: true })
    const platform = plugins.find(row => row.moduleName.endsWith('/platform-plugin/plugin.mjs'))!
    expect(await rpc.remoteRpc(origin, cookie, 'pluginManager/setPluginEnabled', { id: platform.entryId, enabled: false })).toMatchObject({ application: 'failed' })
    const evidence = process.env.DSH_PHALANX_E2E_EVIDENCE_DIR
    if (evidence) { await mkdir(evidence, { recursive: true }); await page.screenshot({ path: join(evidence, 'native-market.png'), animations: 'disabled', fullPage: true }) }
    await adminRequest('plugins/publication', { action: 'publish', packageName: '@example/private-market', published: false })
    await market.getByText('No published plugins', { exact: true }).waitFor()
    expect((await rpc.remoteRpc<Array<{ name: string, installed: boolean }>>(origin, cookie, 'pluginManager/listBundles', {})).find(row => row.name === '@example/private-market')?.installed).toBe(true)
    // An older native profile copy remains independently owned; republishing the checked newer
    // artifact must advertise an update without a platform/member restart for publication itself.
    const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'))
    await writeFile(join(directory, 'package.json'), JSON.stringify({ ...manifest, version: '0.9.0' }))
    const older = JSON.parse(await execFileText('npm', ['pack', directory, '--ignore-scripts', '--json', '--pack-destination', root])) as Array<{ filename: string }>
    await copyFile(join(root, older[0]!.filename), join(runtime.dataRoot, 'users/member/home/older.tgz'))
    expect(await rpc.remoteRpc(origin, cookie, 'pluginManager/installBundle', { spec: '/dsh-phalanx/home/older.tgz' })).toMatchObject({ changed: true })
    expect((await page.request.post(origin + '/recovery/restart', { headers: { origin }, data: { confirmed: true } })).status()).toBe(200)
    await signInCommunity(page, origin, 'member', 'password')
    await page.getByRole('button', { name: 'Platform plugin marketplace', exact: true }).click()
    await market.getByText('No published plugins', { exact: true }).waitFor()
    await adminRequest('plugins/publication', { action: 'publish', packageName: '@example/private-market', published: true })
    await market.getByRole('button', { name: 'Update available', exact: true }).waitFor()
    await market.getByRole('button', { name: 'Update available', exact: true }).click()
    await market.getByText('Plugin updated. Restart your instance to apply the new version.', { exact: true }).waitFor({ timeout: 120000 })

  } catch (error) { console.error('market diagnostic', await page.locator('body').innerText(), await Promise.all(page.frames().map(async frame => [frame.url(), await frame.locator('body').innerText().catch(() => '')]))); throw error } finally { await browser.close(); await app.stop(); await new CommunityRuntimeDriver(runtime).rebuild(); await rm(root, { recursive: true, force: true }) }
}, 300000)
