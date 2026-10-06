import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium, type Browser, type BrowserContext } from 'playwright'
import { afterEach, expect, it } from 'vitest'
import { candidateApplication } from './support/candidate-application.js'
import { CommunityAccountStore } from '../src/adapters/community-account-store.js'
import { CommunityRuntimeDriver } from '../src/adapters/community-runtime-driver.js'
import type { CommunityApplication } from '../src/ports/community-application.js'
import type { CommunityRuntimeConfig } from '../src/domain/community-config.js'
import type { CommunityEnvironmentResetResult } from '../src/domain/admin-contract.js'
import { dshWebProfilePath, DSH_PATCH_CONFIG, DSH_CONTAINER_HOME } from '../src/dsh/profile-layout.js'
import { startCommunityModel } from './fixtures/community-model.js'
import { newValidationContext, saveBrowserEvidence } from './fixtures/browser-evidence.js'
import { signInCommunity, selectCommunityWorkspace, runCommunityTerminal, sendCommunityTerminal } from './fixtures/community-native-browser.js'
import { cookieHeader, createBrowserDshRpc } from './support/real-dsh-rpc.js'
import { runtimeSection, defaultWorkspacePath, instanceWorkspacePath, assertPinnedDshRevision } from './support/real-dsh-runtime.js'
import { runtimeSettings } from './support/real-dsh-kit.js'

let root: string | undefined; let app: CommunityApplication | undefined; let browser: Browser | undefined
let runtime: CommunityRuntimeConfig | undefined; let model: Awaited<ReturnType<typeof startCommunityModel>> | undefined
async function pageFor(context: BrowserContext) {
  const page = await context.newPage(); page.setDefaultTimeout(30_000)
  const rate = Number(process.env.DSH_PHALANX_E2E_CPU_RATE ?? '1')
  if (rate > 1) await (await context.newCDPSession(page)).send('Emulation.setCPUThrottlingRate', { rate })
  return page
}
afterEach(async test => {
  await saveBrowserEvidence(test); model?.release(); await browser?.close(); await app?.stop()
  if (runtime) await new CommunityRuntimeDriver(runtime).rebuild()
  await model?.close(); if (root) await rm(root, { recursive: true, force: true })
})
it('repairs actual broken config and required user plugin from the admin page, preserving chat, projects, personal files and a connected peer', async () => {
  assertPinnedDshRevision(runtimeSettings)
  root = await mkdtemp(join(tmpdir(), 'community-admin-recovery-')); model = await startCommunityModel()
  runtime = runtimeSection(root, model.origin, runtimeSettings)
  app = candidateApplication({ listen: { host: '127.0.0.1', port: 0 }, sessionSecret: 'environment-action-session-fixture-32-bytes', runtime,
    modelGateway: { upstreamApiKey: 'community-provider-fixture-key' } })
  const accounts = new CommunityAccountStore(join(root, 'community-accounts.db'))
  try {
    await accounts.createFirstAdmin({ username: 'admin', email: '', password: 'password' })
    for (const username of ['alice', 'bob', 'newcomer']) await accounts.create({ username, email: '', password: 'password' })
  } finally { accounts.close() }
  const origin = await app.start(); browser = await chromium.launch({ headless: true })
  const adminContext = await newValidationContext(browser); const admin = await pageFor(adminContext)
  await signInCommunity(admin, origin, 'admin', 'password', true)
  const reset = async (username: string) => {
    await admin.getByRole('button', { name: `More actions for ${username}`, exact: true }).click()
    await admin.getByRole('menuitem', { name: `Reset DSH environment for ${username}`, exact: true }).click()
    const dialog = admin.getByRole('dialog'); await dialog.getByRole('heading', { name: `Reset DSH environment: ${username}`, exact: true }).waitFor()
    expect(await dialog.getByRole('button', { name: 'Reset environment', exact: true }).isEnabled()).toBe(false)
    await dialog.getByRole('checkbox').check()
    const response = admin.waitForResponse(r => new URL(r.url()).pathname === `/admin/api/accounts/${username}/reset-environment`)
    await dialog.getByRole('button', { name: 'Reset environment', exact: true }).click()
    const reply = await response; expect(reply.status()).toBe(200)
    const result = await reply.json() as CommunityEnvironmentResetResult
    await admin.getByRole('status').filter({ hasText: `DSH environment reset for ${username}.` }).waitFor({ timeout: 300_000 })
    await admin.getByRole('region', { name: 'Environment backup' }).getByText(result.backup.location, { exact: true }).waitFor()
    return result
  }
  // No previous member carrier is required for this admin operation.
  const first = await reset('newcomer'); expect(first.entry).toMatch(/^\/app\/[a-f0-9]{32}\/$/u)
  const worlds = []
  for (const username of ['alice', 'bob']) {
    const context = await newValidationContext(browser); const page = await pageFor(context)
    let opened = 0; let closed = 0; page.on('websocket', socket => { opened++; socket.on('close', () => { closed++ }) })
    await signInCommunity(page, origin, username, 'password')
    const entry = page.url()
    await selectCommunityWorkspace(context, page, origin, instanceWorkspacePath(defaultWorkspacePath(root, username), runtime.container !== undefined), runtime.container !== undefined)
    await runCommunityTerminal(page, `printf '${username.toUpperCase()}_PROJECT' > keep-project.txt; printf '${username.toUpperCase()}_HOME' > "$HOME/keep-home.txt"; printf 'FILES_%s' SAVED`, 'FILES_SAVED')
    worlds.push({ context, page, entry, opened: () => opened, closed: () => closed })
  }
  const alice = worlds[0]!; const bob = worlds[1]!
  await alice.page.locator('[data-composer-input]').fill('PERSIST_CHAT_TASK'); await alice.page.locator('[data-composer-input]').press('Enter')
  await alice.page.getByText('COMMUNITY_', { exact: true }).waitFor(); model.release()
  await alice.page.locator('p').filter({ hasText: 'COMMUNITY_MODEL_READY' }).last().waitFor()
  const peerClosed = bob.closed(); expect(bob.opened()).toBeGreaterThan(0)
  const home = join(root, 'users/alice/home'); const patch = join(dshWebProfilePath(home), DSH_PATCH_CONFIG)
  const failRestart = async () => {
    await alice.page.goto(`${origin}/recovery`); await alice.page.getByRole('checkbox').check()
    await alice.page.getByRole('button', { name: 'Restart instance', exact: true }).click()
    await alice.page.getByRole('status').filter({ hasText: 'Restart failed.' }).waitFor({ timeout: 300_000 })
    expect((await alice.context.request.get(alice.entry, { maxRedirects: 0 })).status()).toBe(503)
  }
  const verifyRecovered = async () => {
    await alice.page.goto(`${origin}/enter`); expect(alice.page.url()).toBe(alice.entry)
    await alice.page.getByRole('link', { name: 'Restart instance', exact: true }).waitFor()
    await alice.page.getByRole('treeitem').filter({ has: alice.page.getByText('COMMUNITY_TITLE', { exact: true }) }).last().click()
    await alice.page.locator('p').filter({ hasText: 'COMMUNITY_MODEL_READY' }).last().waitFor()
    await runCommunityTerminal(alice.page, 'cat keep-project.txt "$HOME/keep-home.txt"', 'ALICE_PROJECTALICE_HOME')
    expect(bob.closed()).toBe(peerClosed)
  }
  console.info('environment acceptance: member files and chat created')
  await writeFile(patch, 'broken-profile: true\n'); await failRestart()
  const configReset = await reset('alice'); expect(`${origin}${configReset.entry}`).toBe(alice.entry)
  expect(await readFile(join(configReset.backup.location, 'files/.dsh/profiles/web/cordis.patch.yml'), 'utf8')).toBe('broken-profile: true\n')
  await verifyRecovered(); console.info('environment acceptance: broken config recovered with chat and files')
  // An actual member module fails its required activation. It remains a personal
  // file; resetting removes only the profile entry that activates it.
  const plugin = join(home, 'member-broken-plugin.mjs')
  await writeFile(plugin, 'export default function () { throw new Error("BROKEN_PLUGIN_FIXTURE") }\n')
  const nativePlugin = runtime.container === undefined ? plugin : join(DSH_CONTAINER_HOME, 'member-broken-plugin.mjs')
  await writeFile(patch, JSON.stringify([{ id: 'webserver', module: nativePlugin, config: {} }]))
  await failRestart()
  console.info('environment acceptance: required plugin fails startup')
  const pluginReset = await reset('alice'); expect(`${origin}${pluginReset.entry}`).toBe(alice.entry)
  expect(await readFile(join(pluginReset.backup.location, 'files/.dsh/profiles/web/cordis.patch.yml'), 'utf8')).toContain('member-broken-plugin.mjs')
  expect(await readFile(plugin, 'utf8')).toContain('BROKEN_PLUGIN_FIXTURE')
  await verifyRecovered()
  const plugins = await createBrowserDshRpc(alice.context).remoteRpc<{ moduleName: string, fiberPhase: string }[]>(origin, await cookieHeader(alice.context, origin), 'pluginManager/listPlugins', {})
  expect(plugins.some(row => row.moduleName.endsWith('/platform-plugin/plugin.mjs') && row.fiberPhase === 'active')).toBe(true)
  expect(plugins.some(row => row.moduleName.endsWith('/member-broken-plugin.mjs'))).toBe(false)
  await alice.page.locator('[data-composer-input]').fill('AFTER_RESET_SHARED_TASK'); await alice.page.locator('[data-composer-input]').press('Enter')
  await alice.page.getByText('COMMUNITY_', { exact: true }).waitFor(); model.release()
  await expect.poll(async () => await alice.page.locator('p').filter({ hasText: 'COMMUNITY_MODEL_READY' }).count()).toBe(2)
  await sendCommunityTerminal(bob.page, 'cat keep-project.txt "$HOME/keep-home.txt"', 'BOB_PROJECTBOB_HOME')
  expect(bob.closed()).toBe(peerClosed)
  if (runtime.container !== undefined) {
    // The platform backup path is not part of any member's mounted filesystem.
    await sendCommunityTerminal(bob.page, `if [ -e '${pluginReset.backup.location}' ]; then printf 'BACKUP_%s' VISIBLE; else printf 'BACKUP_%s' PRIVATE; fi`, 'BACKUP_PRIVATE')
  }
  expect((await bob.context.request.get(`${origin}/admin/api/accounts/alice/reset-environment`, { maxRedirects: 0 })).status()).toBe(403)
}, 600_000)
