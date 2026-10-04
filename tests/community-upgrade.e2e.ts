import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium, type Browser, type Page } from 'playwright'
import { afterEach, expect, it } from 'vitest'
import { CommunityRuntimeDriver } from '../src/adapters/community-runtime-driver.js'
import { readBootstrapCredential } from '../src/adapters/bootstrap-credential.js'
import type { CommunityApplication } from '../src/ports/community-application.js'
import type { CommunityRuntimeConfig } from '../src/domain/community-config.js'
import type { CommunityModelSettings } from '../src/domain/admin-contract.js'
import { dshWebProfilePath, DSH_PATCH_CONFIG } from '../src/dsh/profile-layout.js'
import { runtimeSettings } from './support/real-dsh-kit.js'
import { assertPinnedDshRevision, runtimeSection, defaultWorkspacePath, instanceWorkspacePath } from './support/real-dsh-runtime.js'
import { cookieHeader, createBrowserDshRpc } from './support/real-dsh-rpc.js'
import { loginAndChooseWorkspace } from './fixtures/real-dsh-browser.js'
import { signInCommunity, selectCommunityWorkspace, runCommunityTerminal } from './fixtures/community-native-browser.js'
import { newValidationContext, saveBrowserEvidence } from './fixtures/browser-evidence.js'
import { upgradeApplication } from './support/upgrade-application.js'

let app: CommunityApplication | undefined, runtime: CommunityRuntimeConfig | undefined, root: string | undefined, browser: Browser | undefined
async function throttle(page: Page): Promise<void> {
  page.setDefaultTimeout(30_000)
  const rate = Number(process.env.DSH_PHALANX_E2E_CPU_RATE ?? '1')
  if (rate > 1) await (await page.context().newCDPSession(page)).send('Emulation.setCPUThrottlingRate', { rate })
}
afterEach(async test => {
  await saveBrowserEvidence(test); await browser?.close(); await app?.stop()
  if (runtime) await new CommunityRuntimeDriver(runtime).rebuild()
  if (root && process.env.DSH_PHALANX_UPGRADE_RETAIN_ROOT !== '1') await rm(root, { recursive: true, force: true })
})

it.skipIf(!process.env.DSH_PHALANX_OLD_INSTALL_ROOT || !process.env.DSH_PHALANX_OLD_CONTAINER_IMAGE || !process.env.DSH_PHALANX_REAL_DEEPSEEK_KEY_FILE)(
  'upgrades actual 0.1.0 platform and harness data without clearing chats, installed plugins, files or later administrator changes', async () => {
    assertPinnedDshRevision(runtimeSettings)
    const previousRoot = process.env.DSH_PHALANX_OLD_INSTALL_ROOT!, oldImage = process.env.DSH_PHALANX_OLD_CONTAINER_IMAGE!
    const oldInfo = JSON.parse(await readFile(join(previousRoot, 'build-info.json'), 'utf8')) as { sourceSha?: string }
    const oldVersion = JSON.parse(await readFile(join(previousRoot, 'runtime-versions.json'), 'utf8')) as { dsh: { revision: string } }
    if (process.env.DSH_PHALANX_INSTALL_ROOT) {
      const candidate = JSON.parse(await readFile(join(process.env.DSH_PHALANX_INSTALL_ROOT, 'build-info.json'), 'utf8')) as { commit: string }
      expect(process.env.DSH_PHALANX_CANDIDATE_SHA).toBeTruthy()
      expect(candidate.commit).toBe(process.env.DSH_PHALANX_CANDIDATE_SHA)
    }
    const oldLabel = execFileSync(runtimeSettings.containerRuntimeCli, ['image', 'inspect', oldImage, '--format', '{{index .Config.Labels "dsh.revision"}}'], { encoding: 'utf8' }).trim()
    expect(oldLabel).toBe(oldVersion.dsh.revision)
    expect(oldLabel).not.toBe('5badb15009ae1756c3afe0ae0cef1faafc290ccc')
    let key = (await readFile(process.env.DSH_PHALANX_REAL_DEEPSEEK_KEY_FILE!, 'utf8')).split('\n').find(row => row.startsWith('DEEPSEEK_API_KEY='))?.slice('DEEPSEEK_API_KEY='.length).trim() ?? ''
    if ((key.startsWith('"') && key.endsWith('"')) || (key.startsWith("'") && key.endsWith("'"))) key = key.slice(1, -1)
    if (!key) throw new Error('Protected DeepSeek credential is required')
    root = await mkdtemp(join(tmpdir(), 'community-real-upgrade-'))
    const current: CommunityRuntimeConfig = runtimeSection(root, 'https://api.deepseek.com', runtimeSettings)
    if (!current.container) throw new Error('Actual old artifact upgrade requires Linux containers')
    runtime = { ...current, container: { ...current.container, image: oldImage } }
    const config = { listen: { host: '127.0.0.1', port: 0 }, sessionSecret: 'upgrade-real-service-session-secret-32-bytes', runtime,
      network: { hostPublicAddresses: process.env.DSH_PHALANX_E2E_HOST_PUBLIC_ADDRESSES?.split(',') ?? [] }, modelGateway: { upstreamApiKey: key } }
    app = upgradeApplication(config, previousRoot)
    let origin = await app.start(); browser = await chromium.launch({ headless: true })
    const admin = await newValidationContext(browser)
    const first = await admin.request.post(`${origin}/bootstrap`, { maxRedirects: 0, form: {
      credential: readBootstrapCredential(root)!.credential, username: 'admin', email: 'admin@example.test', password: 'password',
    } })
    expect(first.status()).toBe(303)
    const authenticated = await admin.request.post(`${origin}/login`, { maxRedirects: 0, form: { username: 'admin', password: 'password' }, timeout: 300_000 })
    expect(authenticated.status()).toBe(303)
    const created = await admin.request.post(`${origin}/admin/api/accounts`, { headers: { origin }, data: { username: 'alice', email: 'alice@example.test', password: 'password' } })
    expect(created.status()).toBe(201)
    const context = await newValidationContext(browser)
    const rpc = createBrowserDshRpc(context)
    const oldPage = await loginAndChooseWorkspace({ containerMode: true, sessionCwds: async (world, base) =>
      (await createBrowserDshRpc(world).remoteRpc<{ items: { cwd?: string }[] }>(base, await cookieHeader(world, base), 'session/list', { _request: {} })).items.map(row => row.cwd) },
    context, origin, 'alice', 'password', instanceWorkspacePath(defaultWorkspacePath(root, 'alice'), true))
    await throttle(oldPage)
    await runCommunityTerminal(oldPage, 'printf old-project > keep-project.txt; printf old-home > "$HOME/keep-home.txt"; printf "OLD_%s" FILES', 'OLD_FILES')
    await oldPage.locator('[data-composer-input]').fill('Decode these hexadecimal UTF-8 bytes and reply only with the decoded text: 4f4c445f434841545f505245534552564544. Do not use tools.')
    await oldPage.locator('[data-composer-input]').press('Enter')
    await oldPage.locator('p').filter({ hasText: 'OLD_CHAT_PRESERVED' }).last().waitFor({ timeout: 120_000 })
    await expect.poll(async () => await oldPage.getByRole('button', { name: 'Stop generating', exact: true }).count(), { timeout: 120_000 }).toBe(0)
    const sessions = await rpc.remoteRpc<{ items: { sessionId: string }[] }>(origin, await cookieHeader(context, origin), 'session/list', { _request: {} })
    expect(sessions.items).toHaveLength(1)
    expect(sessions.items.every(row => typeof row.sessionId === 'string' && row.sessionId.length > 0)).toBe(true)
    console.info('upgrade acceptance: old chat and personal files created')
    // A real old personal provider and recorded conversation selection become
    // unavailable under managed supply. The fictional key never leaves the fixture.
    await oldPage.getByRole('button', { name: 'Settings', exact: true }).click()
    await oldPage.getByRole('button', { name: 'Models', exact: true }).click()
    await oldPage.getByRole('button', { name: 'Add model provider', exact: true }).click()
    await oldPage.getByText('Custom model API', { exact: true }).click()
    await oldPage.getByLabel('Provider ID', { exact: true }).fill('personal')
    await oldPage.getByLabel('Base URL', { exact: true }).last().fill('https://models.example.test')
    await oldPage.getByLabel('API protocol', { exact: true }).selectOption('anthropic-messages')
    await oldPage.getByLabel('API key', { exact: true }).last().fill('personal-fixture-key')
    await oldPage.getByRole('button', { name: 'Add model', exact: true }).click()
    await oldPage.getByLabel('Model ID 1', { exact: true }).fill('personal-model')
    await oldPage.getByRole('button', { name: 'Create provider', exact: true }).click()
    await oldPage.getByText('personal', { exact: true }).first().waitFor(); await oldPage.keyboard.press('Escape')
    await oldPage.getByRole('button', { name: /deepseek-chat/u }).click()
    await oldPage.getByRole('menuitem', { name: /^Model/u }).click()
    await oldPage.getByRole('menuitemradio', { name: /personal-model/u }).click()
    await oldPage.getByRole('button', { name: 'Plugins', exact: true }).click()
    await oldPage.getByRole('button', { name: 'Add plugin', exact: true }).click()
    await oldPage.getByLabel('Package name or address', { exact: true }).fill('@aiwayds/dsh-web-search-tavily@0.6.0')
    await oldPage.getByRole('button', { name: 'Install', exact: true }).click()
    const installed = oldPage.getByRole('dialog', { name: 'Installed', exact: true }); await installed.waitFor({ timeout: 180_000 })
    await installed.getByRole('button', { name: 'Enable now', exact: true }).click(); await installed.waitFor({ state: 'hidden' })
    const oldPlugins = await rpc.remoteRpc<{ moduleName: string, fiberPhase: string }[]>(origin, await cookieHeader(context, origin), 'pluginManager/listPlugins', {})
    expect(oldPlugins.some(row => row.moduleName.includes('dsh-web-search-tavily') && row.fiberPhase === 'active')).toBe(true)
    console.info('upgrade acceptance: plugin installed and active on old harness')
    const profile = join(dshWebProfilePath(join(root, 'users/alice/home')), DSH_PATCH_CONFIG)
    const previousProfile = await readFile(profile)
    const hash = createHash('sha256').update(previousProfile).digest('hex')
    await app.stop(); await new CommunityRuntimeDriver(runtime).rebuild(); await browser.close()
    runtime = current; app = upgradeApplication({ ...config, runtime }, process.env.DSH_PHALANX_INSTALL_ROOT)
    origin = await app.start(); browser = await chromium.launch({ headless: true })
    const management = await newValidationContext(browser), adminPage = await management.newPage()
    await throttle(adminPage)
    await signInCommunity(adminPage, origin, 'admin', 'password', true)
    expect((await management.request.get(`${origin}/bootstrap`)).status()).toBe(404)
    let settings = await (await management.request.get(`${origin}/admin/api/models`)).json() as CommunityModelSettings
    expect(settings.providers.some(provider => provider.models.some(model => model.name === 'deepseek-chat'))).toBe(true)
    const privateModels = await readFile(join(root, 'shared-models.json'), 'utf8')
    expect(privateModels.includes(key), 'Actual prior deployment credential must be imported').toBe(true)
    expect(JSON.stringify(settings).includes(key), 'Actual credential absent from management response').toBe(false)
    const member = await newValidationContext(browser), page = await member.newPage()
    await throttle(page)
    await signInCommunity(page, origin, 'alice', 'password')
    const entry = new URL(page.url()).pathname
    expect(entry).toMatch(/^\/app\/[a-f0-9]{32}\/$/u)
    await selectCommunityWorkspace(member, page, origin, instanceWorkspacePath(defaultWorkspacePath(root, 'alice'), true), true)
    await page.locator('#phalanx-upgrade-notice').waitFor()
    const after = await createBrowserDshRpc(member).remoteRpc<{ items: { sessionId: string }[] }>(origin, await cookieHeader(member, origin), 'session/list', { _request: {} })
    expect(after.items.map(row => row.sessionId)).toEqual(expect.arrayContaining(sessions.items.map(row => row.sessionId)))
    // The native UI may create an empty draft on entry. The oldest conversation
    // remains the final tree row; assert its actual reply after opening it.
    await page.getByRole('treeitem').last().click()
    await page.locator('p').filter({ hasText: 'OLD_CHAT_PRESERVED' }).last().waitFor()
    const plugins = await createBrowserDshRpc(member).remoteRpc<{ moduleName: string, fiberPhase: string }[]>(origin, await cookieHeader(member, origin), 'pluginManager/listPlugins', {})
    expect(plugins.some(row => row.moduleName.includes('dsh-web-search-tavily') && row.fiberPhase === 'active')).toBe(true)
    console.info('upgrade acceptance: original sessions and plugin active on new harness')
    await runCommunityTerminal(page, 'cat keep-project.txt "$HOME/keep-home.txt"', 'old-projectold-home')
    console.info('upgrade acceptance: retained files readable')
    const receiptPath = join(root, 'environment-upgrades', `${entry.split('/')[2]}.json`)
    const receiptSource = await readFile(receiptPath, 'utf8')
    const receipt = JSON.parse(receiptSource) as { backup: { location: string } }
    expect(createHash('sha256').update(await readFile(join(receipt.backup.location, 'files/.dsh/profiles/web/cordis.patch.yml'))).digest('hex')).toBe(hash)
    expect(previousProfile.toString()).toContain('personal-model')
    const catalog = await createBrowserDshRpc(member).remoteRpc(origin, await cookieHeader(member, origin), 'session/modelCatalog', {})
    expect(JSON.stringify(catalog)).not.toContain('personal-model')
    await page.locator('[data-composer-input]').fill('Decode these hexadecimal UTF-8 bytes and reply only with the decoded text: 504552534f4e414c5f4d5553545f4e4f545f52554e. Do not use tools.')
    await page.locator('[data-composer-input]').press('Enter')
    console.info('upgrade acceptance: personal model turn submitted')
    await page.getByText('This turn failed', { exact: true }).waitFor({ timeout: 120_000 })
    expect(await page.locator('p').filter({ hasText: 'PERSONAL_MUST_NOT_RUN' }).count()).toBe(0)
    expect(await page.locator('#phalanx-upgrade-notice').textContent()).toContain('Select an enabled shared model')
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    expect(await page.getByRole('button', { name: 'Add model provider', exact: true }).count()).toBe(0)
    await page.keyboard.press('Escape')
    console.info('upgrade acceptance: unavailable personal model rejected')
    await page.getByRole('button', { name: /personal-model/u }).click()
    await page.getByRole('menuitem', { name: /^Model/u }).click()
    await page.getByRole('menuitemradio', { name: /deepseek-chat/u }).click()
    // Native DSH first resumes the failed turn under the newly selected model.
    await page.locator('[data-composer-input]').fill('Retry the failed turn using the selected shared model. Reply only with the decoded text from its original request.')
    await page.locator('[data-composer-input]').press('Enter')
    await page.locator('p').filter({ hasText: 'PERSONAL_MUST_NOT_RUN' }).last().waitFor({ timeout: 120_000 })
    await expect.poll(async () => await page.getByRole('button', { name: 'Stop generating', exact: true }).count(), { timeout: 120_000 }).toBe(0)
    await page.locator('[data-composer-input]').fill('Decode these hexadecimal UTF-8 bytes and reply only with the decoded text: 555047524144455f5348415245445f4f4b. Do not use tools.')
    await page.locator('[data-composer-input]').press('Enter')
    await page.locator('p').filter({ hasText: 'UPGRADE_SHARED_OK' }).last().waitFor({ timeout: 120_000 })
    await expect.poll(async () => await page.getByRole('button', { name: 'Stop generating', exact: true }).count(), { timeout: 120_000 }).toBe(0)
    const provider = settings.providers[0]!
    const changed = await management.request.post(`${origin}/admin/api/models`, { headers: { origin }, data: {
      action: 'save-provider', revision: settings.revision, provider: { ...provider, name: 'Deployment model retained', models: provider.models },
    } })
    expect(changed.status()).toBe(200); settings = await changed.json() as CommunityModelSettings
    const backupCount = (await readdir(join(root, 'environment-backups', entry.split('/')[2]!))).length
    await app.stop(); await new CommunityRuntimeDriver(runtime).rebuild(); await browser.close()
    app = upgradeApplication({ ...config, runtime }, process.env.DSH_PHALANX_INSTALL_ROOT); origin = await app.start(); browser = await chromium.launch({ headless: true })
    const again = await newValidationContext(browser), againPage = await again.newPage()
    await throttle(againPage)
    await signInCommunity(againPage, origin, 'admin', 'password', true)
    expect(await (await again.request.get(`${origin}/admin/api/models`)).json()).toEqual(settings)
    await signInCommunity(againPage, origin, 'alice', 'password'); expect(new URL(againPage.url()).pathname).toBe(entry)
    await selectCommunityWorkspace(again, againPage, origin, instanceWorkspacePath(defaultWorkspacePath(root, 'alice'), true), true)
    await againPage.getByRole('treeitem').last().click()
    await againPage.locator('p').filter({ hasText: 'OLD_CHAT_PRESERVED' }).last().waitFor()
    await againPage.locator('p').filter({ hasText: 'UPGRADE_SHARED_OK' }).last().waitFor()
    expect((await readdir(join(root, 'environment-backups', entry.split('/')[2]!))).length).toBe(backupCount)
    expect(await readFile(receiptPath, 'utf8')).toBe(receiptSource)
    console.info(JSON.stringify({ oldPlatform: oldInfo, oldDsh: oldLabel, currentDsh: '5badb15009ae1756c3afe0ae0cef1faafc290ccc', oldSessions: sessions.items.length,
      installedPlugin: 'dsh-web-search-tavily@0.6.0', pluginRetainedActive: true, accountAndSpaceRetained: true, actualCredentialImported: true, root }))
  }, 600_000)

it.skipIf(!process.env.DSH_PHALANX_OLD_INSTALL_ROOT || !process.env.DSH_PHALANX_OLD_CONTAINER_IMAGE)(
  'retains an actually removed legacy diagnostic plugin configuration, reports its unloaded native row and resets it through administration', async () => {
    assertPinnedDshRevision(runtimeSettings)
    root = await mkdtemp(join(tmpdir(), 'community-removed-plugin-upgrade-'))
    const current: CommunityRuntimeConfig = runtimeSection(root, 'https://api.deepseek.com', runtimeSettings)
    if (!current.container) throw new Error('This acceptance requires actual Linux containers')
    runtime = { ...current, container: { ...current.container, image: process.env.DSH_PHALANX_OLD_CONTAINER_IMAGE! } }
    const config = { listen: { host: '127.0.0.1', port: 0 }, sessionSecret: 'removed-plugin-upgrade-session-secret-32-bytes', runtime,
      modelGateway: { upstreamApiKey: 'community-provider-fixture-key' } }
    app = upgradeApplication(config, process.env.DSH_PHALANX_OLD_INSTALL_ROOT); let origin = await app.start()
    browser = await chromium.launch({ headless: true })
    const admin = await newValidationContext(browser)
    expect((await admin.request.post(`${origin}/bootstrap`, { maxRedirects: 0, form: {
      credential: readBootstrapCredential(root)!.credential, username: 'admin', email: 'admin@example.test', password: 'password',
    } })).status()).toBe(303)
    expect((await admin.request.post(`${origin}/login`, { maxRedirects: 0, form: { username: 'admin', password: 'password' }, timeout: 300_000 })).status()).toBe(303)
    expect((await admin.request.post(`${origin}/admin/api/accounts`, { headers: { origin }, data: {
      username: 'alice', email: 'alice@example.test', password: 'password',
    } })).status()).toBe(201)
    const home = join(root, 'users/alice/home'), profile = dshWebProfilePath(home), patch = join(profile, DSH_PATCH_CONFIG)
    await mkdir(profile, { recursive: true, mode: 0o700 })
    // This published official plugin existed at the old revision and was removed
    // by the target release. It supplies a real compatibility failure, not a stub.
    await writeFile(patch, JSON.stringify([{ insert: [{ id: 'legacy-diagnostics', name: '@deepseek-ai/dsh-invariants', config: { enabled: true } }] }]), { mode: 0o600 })
    const context = await newValidationContext(browser)
    const oldPage = await loginAndChooseWorkspace({ containerMode: true, sessionCwds: async (world, base) =>
      (await createBrowserDshRpc(world).remoteRpc<{ items: { cwd?: string }[] }>(base, await cookieHeader(world, base), 'session/list', { _request: {} })).items.map(row => row.cwd) },
    context, origin, 'alice', 'password', instanceWorkspacePath(defaultWorkspacePath(root, 'alice'), true))
    await throttle(oldPage)
    const plugins = await createBrowserDshRpc(context).remoteRpc<{ moduleName: string, fiberPhase: string }[]>(origin, await cookieHeader(context, origin), 'pluginManager/listPlugins', {})
    expect(plugins.some(row => row.moduleName.includes('dsh-invariants') && row.fiberPhase === 'active')).toBe(true)
    await runCommunityTerminal(oldPage, 'printf legacy-file > keep-project.txt; printf "LEGACY_%s" SAVED', 'LEGACY_SAVED')
    const legacyPatch = await readFile(patch)
    await app.stop(); await new CommunityRuntimeDriver(runtime).rebuild(); await browser.close()
    runtime = current; app = upgradeApplication({ ...config, runtime }, process.env.DSH_PHALANX_INSTALL_ROOT); origin = await app.start()
    browser = await chromium.launch({ headless: true })
    const management = await newValidationContext(browser), adminPage = await management.newPage(); await throttle(adminPage)
    await signInCommunity(adminPage, origin, 'admin', 'password', true)
    const member = await newValidationContext(browser)
    const login = await member.request.post(`${origin}/login`, { maxRedirects: 0, form: { username: 'alice', password: 'password' }, timeout: 300_000 })
    expect(login.status()).toBe(303)
    const accounts = await (await management.request.get(`${origin}/admin/api/accounts`)).json() as { items: { username: string, spaceId: string }[] }
    const space = accounts.items.find(row => row.username === 'alice')!.spaceId
    expect(login.headers()['location']).toBe(`/app/${space}/`)
    expect((await member.request.get(`${origin}/app/${space}/`, { maxRedirects: 0 })).status()).toBe(200)
    const upgradedPlugins = await createBrowserDshRpc(member).remoteRpc<{ moduleName: string, fiberPhase: string | null }[]>(origin, await cookieHeader(member, origin), 'pluginManager/listPlugins', {})
    const removed = upgradedPlugins.filter(row => row.moduleName.includes('dsh-invariants'))
    expect(removed).toHaveLength(1)
    expect(removed[0]!.fiberPhase).toBeNull()
    expect(await readFile(patch)).toEqual(legacyPatch)
    const receipt = JSON.parse(await readFile(join(root, 'environment-upgrades', `${space}.json`), 'utf8')) as { backup: { location: string } }
    expect(await readFile(join(receipt.backup.location, 'files/.dsh/profiles/web/cordis.patch.yml'))).toEqual(legacyPatch)
    expect((await member.request.get(`${origin}/recovery`)).status()).toBe(200)
    const reset = await management.request.post(`${origin}/admin/api/accounts/alice/reset-environment`, { headers: { origin }, data: { confirmed: true }, timeout: 300_000 })
    expect(reset.status()).toBe(200)
    const result = await reset.json() as { entry: string, backup: { location: string } }
    expect(await readFile(join(result.backup.location, 'files/.dsh/profiles/web/cordis.patch.yml'))).toEqual(legacyPatch)
    const page = await member.newPage(); await throttle(page)
    await page.goto(`${origin}/enter`); expect(new URL(page.url()).pathname).toBe(result.entry)
    await selectCommunityWorkspace(member, page, origin, instanceWorkspacePath(defaultWorkspacePath(root, 'alice'), true), true)
    await runCommunityTerminal(page, 'cat keep-project.txt', 'legacy-file')
    console.info(JSON.stringify({ removedOfficialPlugin: '@deepseek-ai/dsh-invariants', oldActivation: 'active', upgradedEntry: 200, upgradedPluginPhase: removed[0]!.fiberPhase,
      originalConfigRetained: true, upgradeBackupRetained: true, independentRecovery: true, adminReset: 'passed', personalFileRetained: true }))
  }, 600_000)
