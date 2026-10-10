import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { chromium } from 'playwright'
import { expect, it } from 'vitest'
import { readBootstrapCredential } from '../src/adapters/bootstrap-credential.js'
import { CommunityRuntimeDriver } from '../src/adapters/community-runtime-driver.js'
import { execFileText } from '../src/adapters/runtime-command.js'
import { upgradeApplication } from './support/upgrade-application.js'
import { candidateApplication } from './support/candidate-application.js'
import { runtimeSection, assertPinnedDshRevision, CONTAINER_HOME } from './support/real-dsh-runtime.js'
import { runtimeSettings } from './support/real-dsh-kit.js'
import { startCommunityModel } from './fixtures/community-model.js'
import { signInCommunity, selectCommunityWorkspace, runCommunityTerminal } from './fixtures/community-native-browser.js'
import { cookieHeader, createBrowserDshRpc } from './support/real-dsh-rpc.js'
import type { CommunityAccountView, CommunityGroupView } from '../src/domain/admin-contract.js'

it.skipIf(!process.env.DSH_PHALANX_018_INSTALL_ROOT || !runtimeSettings.containerImage)('opens an empty skill library from formal 0.1.8 while retaining plugins, grants, upstreams, access, conversations and files', async () => {
  assertPinnedDshRevision(runtimeSettings)
  const oldRoot = process.env.DSH_PHALANX_018_INSTALL_ROOT!
  expect(JSON.parse(await readFile(join(oldRoot, 'package.json'), 'utf8')).version).toBe('0.1.8')
  expect(JSON.parse(await readFile(join(oldRoot, 'build-info.json'), 'utf8')).commit).toBe('fd54223c30a0997150a977549deae4f2702d0cff')
  const root = await mkdtemp(join(tmpdir(), 'formal018-skills-')); const model = await startCommunityModel()
  const runtime = runtimeSection(root, model.origin, runtimeSettings)
  const config = { listen: { host: '127.0.0.1', port: 0 }, sessionSecret: 'formal018-upgrade-fixture-secret-value', runtime, modelGateway: { upstreamApiKey: 'community-provider-fixture-key' } }
  let app = upgradeApplication(config, oldRoot); const browser = await chromium.launch({ headless: true })
  try {
    let origin = await app.start()
    const admin = await browser.newContext({ locale: 'en' }); const member = await browser.newContext({ locale: 'en' })
    const bootstrap = await admin.request.post(origin + '/bootstrap', { maxRedirects: 0, headers: { origin }, form: { credential: readBootstrapCredential(root)!.credential, username: 'admin', email: 'admin@example.test', password: 'password' } })
    expect(bootstrap.status()).toBe(303)
    expect((await admin.request.post(origin + '/admin/api/accounts', { headers: { origin }, data: { username: 'member', email: 'member@example.test', password: 'password' } })).status()).toBe(201)
    const beforeAccounts = (await (await admin.request.get(origin + '/admin/api/accounts')).json()).items as CommunityAccountView[]
    const beforeModels = await (await admin.request.get(origin + '/admin/api/models')).json()
    const page = await member.newPage(); page.setDefaultTimeout(30000)
    await signInCommunity(page, origin, 'member', 'password')
    const entry = new URL(page.url()).pathname
    await selectCommunityWorkspace(member, page, origin, CONTAINER_HOME + '/Documents/deepseek-harness/default-workspace', true)
    await runCommunityTerminal(page, 'printf OLD_PROJECT > preserved-project.txt; printf OLD_HOME > "$HOME/preserved-home.txt"; printf "UPGRADE_%s" FILES', 'UPGRADE_FILES')
    await page.locator('[data-composer-input]').fill('PERSIST_CHAT_TASK'); await page.locator('[data-composer-input]').press('Enter')
    await page.getByText('COMMUNITY_', { exact: true }).waitFor(); model.release()
    await page.locator('p').filter({ hasText: 'COMMUNITY_MODEL_READY' }).last().waitFor()
    const rpc = createBrowserDshRpc(member)
    const beforeSessions = await rpc.remoteRpc<{ items: { sessionId: string }[] }>(origin, await cookieHeader(member, origin), 'session/list', { _request: {} })
    expect(beforeSessions.items.length).toBeGreaterThan(0)
    const home = join(root, 'users/member/home'); const source = join(root, 'native-fixture'); await mkdir(source)
    await writeFile(join(source, 'package.json'), JSON.stringify({ name: '@example/retained', version: '1.0.0', type: 'module', main: './index.js', dsh: { bundle: { patch: './patch.yml' } } }))
    await writeFile(join(source, 'index.js'), "import {writeFileSync} from 'node:fs';export const name='retained';export function apply(){writeFileSync(process.env.HOME+'/SELF_PLUGIN_ACTIVE','yes')}")
    await writeFile(join(source, 'patch.yml'), '[{"insert":[{"id":"retained","name":"@example/retained"}]}]')
    const packed = JSON.parse(await execFileText('npm', ['pack', source, '--ignore-scripts', '--json', '--pack-destination', home])) as { filename: string }[]
    const installed = await rpc.remoteRpc<{ application: string }>(origin, await cookieHeader(member, origin), 'pluginManager/installBundle', { spec: CONTAINER_HOME + '/' + packed[0]!.filename })
    expect(installed.application).toBe('applied'); expect(await readFile(join(home, 'SELF_PLUGIN_ACTIVE'), 'utf8')).toBe('yes')
    const platformPackage = '@example/platform-retained', platformSource = join(root, 'platform-fixture')
    await mkdir(platformSource)
    await writeFile(join(platformSource, 'package.json'), JSON.stringify({ name: platformPackage, version: '1.0.0', type: 'module', main: './index.js', dsh: { bundle: { patch: './patch.yml' } } }))
    await writeFile(join(platformSource, 'index.js'), "import {writeFileSync} from 'node:fs'; export const name='platform-retained'; export function apply(){writeFileSync(process.env.HOME+'/PLATFORM_PLUGIN_ACTIVE',process.env.RETAINED_SETTING ?? 'missing')}")
    await writeFile(join(platformSource, 'patch.yml'), JSON.stringify([{ insert: [{ id: 'platform-retained', name: platformPackage }] }]))
    const platformPacked = JSON.parse(await execFileText('npm', ['pack', platformSource, '--ignore-scripts', '--json', '--pack-destination', root])) as { filename: string }[]
    const post = (path: string, data: object) => admin.request.post(origin + '/admin/api/' + path, { headers: { origin }, data })
    const upload = await admin.request.post(origin + '/admin/api/plugins/upload', { headers: { origin, 'content-type': 'application/gzip', 'x-plugin-filename': 'retained.tgz' }, data: await readFile(join(root, platformPacked[0]!.filename)) })
    expect(upload.status()).toBe(202)
    await expect.poll(async () => (await (await admin.request.get(origin + '/admin/api/plugins')).json())[0]?.stage, { timeout: 300000 }).toBe('available')
    const query = '?packageName=' + encodeURIComponent(platformPackage)
    expect((await post('plugins/upstreams' + query, { action: 'save', upstream: { name: 'retained', baseUrl: 'https://example.test/retained', credential: 'fixture-only', headers: [{ name: 'Authorization', value: 'Bearer {credential}' }] } })).status()).toBe(200)
    expect((await post('plugins/access' + query, { environment: [{ name: 'RETAINED_SETTING', value: 'old-access-preserved' }], entriesYaml: '{}' })).status()).toBe(200)
    const defaultGroup = (await (await admin.request.get(origin + '/admin/api/groups')).json() as CommunityGroupView[]).find(group => group.isDefault)!
    expect((await post(`groups/${defaultGroup.id}/plugins`, { action: 'save', packages: [platformPackage] })).status()).toBe(200)
    expect((await post('plugins/publication', { action: 'publish', packageName: platformPackage, published: true, confirmed: true })).status()).toBe(200)
    expect((await post(`groups/${defaultGroup.id}/plugins`, { action: 'restart', confirmed: true })).status()).toBe(200)
    expect(await readFile(join(home, 'PLATFORM_PLUGIN_ACTIVE'), 'utf8')).toBe('old-access-preserved')
    const retainedPaths = ['plugins/grants.json', 'plugin-upstreams.json', 'plugins/access.json']
    const oldCarriers = await Promise.all(retainedPaths.map(path => readFile(join(root, path))))
    const beforeLibrary = await (await admin.request.get(origin + '/admin/api/plugins')).json()
    const personalSkill = join(home, '.dsh/skills/personal-retained'); await mkdir(personalSkill, { recursive: true })
    await writeFile(join(personalSkill, 'SKILL.md'), '---\nname: personal-retained\ndescription: Keep my skill\n---\nMember owned')
    const personalManifest = await readFile(join(home, '.dsh/profiles/web/package.json'), 'utf8')
    await page.close(); await app.stop(); await new CommunityRuntimeDriver(runtime).rebuild()
    const oldDb = new DatabaseSync(join(root, 'community-accounts.db')); expect(oldDb.prepare('PRAGMA user_version').get()?.user_version).toBe(5); oldDb.close()
    app = candidateApplication(config); origin = await app.start()
    const newDb = new DatabaseSync(join(root, 'community-accounts.db')); expect(newDb.prepare('PRAGMA user_version').get()?.user_version).toBe(5); newDb.close()
    const adminPage = await admin.newPage(); await signInCommunity(adminPage, origin, 'admin', 'password', true)
    const afterAccounts = (await (await admin.request.get(origin + '/admin/api/accounts')).json()).items as CommunityAccountView[]
    for (const account of beforeAccounts) {
      const after = afterAccounts.find(value => value.username === account.username)!
      expect(after).toMatchObject({ username: account.username, email: account.email, admin: account.admin, disabled: account.disabled, spaceId: account.spaceId })
      expect(after.groupId).toBe(account.admin ? 'admin' : 'default')
    }
    const groups = await (await admin.request.get(origin + '/admin/api/groups')).json() as CommunityGroupView[]
    expect(groups.find(group => group.id === 'default')).toMatchObject({ kind: 'ordinary', isDefault: true })
    expect(groups.find(group => group.id === 'admin')).toMatchObject({ kind: 'admin' })
    expect(await (await admin.request.get(origin + '/admin/api/models')).json()).toEqual(beforeModels)
    expect(await (await admin.request.get(origin + '/admin/api/skills')).json()).toEqual([])
    expect(groups.every(group => group.skillCount === 0)).toBe(true)
    expect(await Promise.all(retainedPaths.map(path => readFile(join(root, path))))).toEqual(oldCarriers)
    await expect.poll(async () => (await (await admin.request.get(origin + '/admin/api/plugins')).json())[0]?.stage, { timeout: 300000 }).toBe('available')
    const afterLibrary = await (await admin.request.get(origin + '/admin/api/plugins')).json()
    expect(afterLibrary).toEqual(beforeLibrary)
    expect(await readFile(join(personalSkill, 'SKILL.md'), 'utf8')).toContain('Member owned')
    const upgraded = await member.newPage(); upgraded.setDefaultTimeout(30000)
    await signInCommunity(upgraded, origin, 'member', 'password'); expect(new URL(upgraded.url()).pathname).toBe(entry)
    await selectCommunityWorkspace(member, upgraded, origin, CONTAINER_HOME + '/Documents/deepseek-harness/default-workspace', true)
    const afterSessions = await rpc.remoteRpc<{ items: { sessionId: string }[] }>(origin, await cookieHeader(member, origin), 'session/list', { _request: {} })
    expect(afterSessions.items.map(row => row.sessionId)).toEqual(expect.arrayContaining(beforeSessions.items.map(row => row.sessionId)))
    await upgraded.getByRole('treeitem').filter({ has: upgraded.getByText('COMMUNITY_TITLE', { exact: true }) }).last().click()
    await upgraded.locator('p').filter({ hasText: 'COMMUNITY_MODEL_READY' }).last().waitFor()
    await runCommunityTerminal(upgraded, 'cat preserved-project.txt "$HOME/preserved-home.txt" "$HOME/SELF_PLUGIN_ACTIVE"', 'OLD_PROJECTOLD_HOMEyes')
    const plugins = await rpc.remoteRpc<{ moduleName: string, fiberPhase: string }[]>(origin, await cookieHeader(member, origin), 'pluginManager/listPlugins', {})
    expect(plugins.some(plugin => plugin.moduleName.includes('@example/retained') && plugin.fiberPhase === 'active')).toBe(true)
    expect(await readFile(join(home, '.dsh/profiles/web/package.json'), 'utf8')).toBe(personalManifest)
    expect(plugins.some(plugin => plugin.moduleName.includes('@example/platform-retained') && plugin.fiberPhase === 'active')).toBe(true)
    expect(await readFile(join(home, 'PLATFORM_PLUGIN_ACTIVE'), 'utf8')).toBe('old-access-preserved')
    console.info('formal 0.1.8 migration: accounts/schema/groups/space IDs/models/chat/native plugin/projects/home preserved')
  } finally { model.release(); await browser.close(); await app.stop(); await new CommunityRuntimeDriver(runtime).rebuild(); await model.close(); await rm(root, { recursive: true, force: true }) }
}, 420000)
