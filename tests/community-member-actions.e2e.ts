import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium, type Browser, type BrowserContext } from 'playwright'
import { afterEach, expect, it } from 'vitest'
import { candidateApplication } from './support/candidate-application.js'
import { CommunityAccountStore } from '../src/adapters/community-account-store.js'
import { CommunityRuntimeDriver } from '../src/adapters/community-runtime-driver.js'
import { platformPluginClient } from '../src/dsh/community-platform-client.js'
import type { CommunityApplication } from '../src/ports/community-application.js'
import type { CommunityRuntimeConfig } from '../src/domain/community-config.js'
import { dshWebProfilePath, DSH_PATCH_CONFIG } from '../src/dsh/profile-layout.js'
import { SESSION_LIST } from '../src/dsh/session-protocol.js'
import { startCommunityModel } from './fixtures/community-model.js'
import { newValidationContext, saveBrowserEvidence } from './fixtures/browser-evidence.js'
import { openCommunityAccountMenu, signInCommunity, selectCommunityWorkspace, runCommunityTerminal, sendCommunityTerminal } from './fixtures/community-native-browser.js'
import { cookieHeader, createBrowserDshRpc } from './support/real-dsh-rpc.js'
import { runtimeSection, defaultWorkspacePath, instanceWorkspacePath, assertPinnedDshRevision } from './support/real-dsh-runtime.js'
import { runtimeSettings } from './support/real-dsh-kit.js'

let root: string | undefined; let app: CommunityApplication | undefined; let browser: Browser | undefined
let runtime: CommunityRuntimeConfig | undefined; let model: Awaited<ReturnType<typeof startCommunityModel>> | undefined
async function validationPage(context: BrowserContext) {
  const page = await context.newPage()
  const rate = Number(process.env.DSH_PHALANX_E2E_CPU_RATE ?? '1')
  if (rate > 1) await (await context.newCDPSession(page)).send('Emulation.setCPUThrottlingRate', { rate })
  return page
}
afterEach(async test => {
  await saveBrowserEvidence(test); model?.release(); await browser?.close(); await app?.stop()
  if (runtime) await new CommunityRuntimeDriver(runtime).rebuild()
  await model?.close(); if (root) await rm(root, { recursive: true, force: true })
})
it('logs out without cancelling a running task and recovers its own failed restart independently while a peer stays connected', async () => {
  assertPinnedDshRevision(runtimeSettings)
  root = await mkdtemp(join(tmpdir(), 'community-member-recovery-')); model = await startCommunityModel()
  runtime = runtimeSection(root, model.origin, runtimeSettings)
  app = candidateApplication({ listen: { host: '127.0.0.1', port: 0 }, sessionSecret: 'member-action-session-fixture-32-bytes', runtime,
    modelGateway: { upstreamApiKey: 'community-provider-fixture-key' } })
  const accounts = new CommunityAccountStore(join(root, 'community-accounts.db'))
  try { for (const username of ['alice', 'bob']) await accounts.create({ username, email: `${username}@example.test`, password: 'password' }) } finally { accounts.close() }
  const origin = await app.start(); browser = await chromium.launch({ headless: true })
  const worlds = []
  for (const username of ['alice', 'bob']) {
    const context = await newValidationContext(browser); const page = await validationPage(context); page.setDefaultTimeout(30_000)
    let closed = 0; let opened = 0
    page.on('websocket', socket => { opened++; socket.on('close', () => { closed++ }) })
    await signInCommunity(page, origin, username, 'password')
    const entry = page.url()
    await selectCommunityWorkspace(context, page, origin, instanceWorkspacePath(defaultWorkspacePath(root, username), runtime.container !== undefined), runtime.container !== undefined)
    await page.getByRole('button', { name: /^Platform account:/u }).waitFor()
    worlds.push({ context, page, entry, closed: () => closed, opened: () => opened })
  }
  const alice = worlds[0]!; const bob = worlds[1]!
  expect(await (await alice.context.request.get(`${origin}/account/identity`)).json()).toEqual({ username: 'alice' })
  expect((await alice.context.request.get(`${origin}/admin/api/session`)).status()).toBe(403)
  const account = alice.page.getByRole('button', { name: 'Platform account: alice', exact: true })
  const settings = alice.page.getByRole('button', { name: 'Settings', exact: true })
  expect(await alice.page.locator('#phalanx-platform-actions').count()).toBe(0)
  expect((await settings.boundingBox())!.y).toBeGreaterThan((await account.boundingBox())!.y)
  await settings.click(); await alice.page.getByRole('dialog', { name: 'Settings', exact: true }).waitFor(); await alice.page.keyboard.press('Escape')
  await settings.click()
  await alice.page.getByRole('button', { name: 'English', exact: true }).click()
  await alice.page.getByRole('menuitem', { name: '中文', exact: true }).click()
  await expect.poll(() => alice.page.locator('html').getAttribute('lang')).toBe('zh-CN')
  await alice.page.keyboard.press('Escape')
  const translatedAccount = alice.page.getByRole('button', { name: '平台账户: alice', exact: true })
  await translatedAccount.click()
  expect(await alice.page.getByRole('menuitem').allTextContents()).toEqual(['重启实例', '退出登录'])
  expect(await translatedAccount.getAttribute('title')).toBe('平台账户: alice')
  await alice.page.keyboard.press('Escape')
  await alice.page.getByRole('button', { name: '设置', exact: true }).click()
  await alice.page.getByRole('button', { name: '中文', exact: true }).click()
  await alice.page.getByRole('menuitem', { name: 'English', exact: true }).click()
  await expect.poll(() => alice.page.locator('html').getAttribute('lang')).toBe('en')
  await alice.page.keyboard.press('Escape')
  await account.focus(); await alice.page.keyboard.press('Enter')
  expect(await alice.page.getByRole('menuitem').allTextContents()).toEqual(['Restart instance', 'Log out'])
  const menu = alice.page.getByRole('menu')
  expect((await menu.boundingBox())!.y + (await menu.boundingBox())!.height).toBeLessThanOrEqual((await account.boundingBox())!.y)
  await alice.page.keyboard.press('ArrowDown'); await alice.page.keyboard.press('Escape')
  await expect.poll(() => account.evaluate(element => element === document.activeElement)).toBe(true)
  const avatar = alice.page.locator('.phalanx-account-avatar')
  const colors: string[] = []
  for (const scheme of ['light', 'dark'] as const) {
    await alice.page.emulateMedia({ colorScheme: scheme })
    await expect.poll(() => alice.page.locator('body').evaluate(element => element.hasAttribute('data-ds-dark-theme'))).toBe(scheme === 'dark')
    colors.push(await avatar.evaluate(element => getComputedStyle(element).color))
    await openCommunityAccountMenu(alice.page); await alice.page.keyboard.press('Escape')
  }
  expect(colors[0]).not.toBe(colors[1])
  await alice.page.getByRole('button', { name: 'Collapse sidebar', exact: true }).click()
  await expect.poll(() => account.locator('.phalanx-account-name').count()).toBe(0)
  await openCommunityAccountMenu(alice.page); await alice.page.keyboard.press('Escape')
  await alice.page.getByRole('button', { name: 'Open sidebar', exact: true }).click()
  await alice.page.setViewportSize({ width: 390, height: 844 })
  await openCommunityAccountMenu(alice.page)
  const mobileMenu = (await menu.boundingBox())!
  expect(mobileMenu.x).toBeGreaterThanOrEqual(0); expect(mobileMenu.x + mobileMenu.width).toBeLessThanOrEqual(390)
  await alice.page.screenshot({ path: '/tmp/phalanx-account-menu-mobile.png', fullPage: true })
  await alice.page.keyboard.press('Escape'); await alice.page.setViewportSize({ width: 1280, height: 800 })
  const clientFailure = await newValidationContext(browser); const degraded = await clientFailure.newPage(); let injected = 0
  await clientFailure.route('**/plugins/**', async route => {
    if (new URL(route.request().url()).pathname.endsWith('/events')) { await route.continue(); return }
    const response = await route.fetch(); const body = await response.text()
    if (!body.includes(platformPluginClient)) { await route.fulfill({ response }); return }
    injected++
    const failed = platformPluginClient.replace("const React=require('react');", "throw new Error('Fixture platform client unavailable');")
    await route.fulfill({ status: response.status(), body: body.replace(platformPluginClient, failed), contentType: 'application/javascript' })
  })
  await signInCommunity(degraded, origin, 'alice', 'password')
  await degraded.locator('[data-composer-input]').waitFor({ timeout: 30_000 }); expect(injected).toBeGreaterThan(0)
  await degraded.getByRole('button', { name: 'Settings', exact: true }).click(); await degraded.getByRole('dialog', { name: 'Settings', exact: true }).waitFor()
  await degraded.goto(`${origin}/recovery`); await degraded.getByRole('heading', { name: 'Instance recovery', exact: true }).waitFor()
  await clientFailure.close()
  await runCommunityTerminal(alice.page, "printf 'KEEP_PROJECT' > keep-project.txt; printf 'KEEP_HOME' > \"$HOME/keep-home.txt\"; printf 'FILES_%s' SAVED", 'FILES_SAVED')
  const otherDevice = await newValidationContext(browser)
  expect((await otherDevice.request.post(`${origin}/login`, { form: { username: 'alice', password: 'password' }, headers: { origin }, maxRedirects: 0 })).status()).toBe(303)
  const taskState = async () => await createBrowserDshRpc(otherDevice).remoteRpc<{ items: { running: boolean }[] }>(origin, await cookieHeader(otherDevice, origin), SESSION_LIST, { _request: {} })
  await alice.page.locator('[data-composer-input]').fill('STREAM_MODEL_TASK'); await alice.page.locator('[data-composer-input]').press('Enter')
  await alice.page.getByText('COMMUNITY_', { exact: true }).waitFor(); expect((await taskState()).items.some(row => row.running)).toBe(true)
  await openCommunityAccountMenu(alice.page); await alice.page.getByRole('menuitem', { name: 'Log out', exact: true }).click(); await alice.page.waitForURL(`${origin}/login`)
  expect((await alice.context.request.get(alice.entry, { maxRedirects: 0 })).headers().location).toBe('/login')
  expect((await taskState()).items.some(row => row.running)).toBe(true)
  model.release(); await expect.poll(async () => (await taskState()).items.some(row => row.running)).toBe(false)
  await signInCommunity(alice.page, origin, 'alice', 'password'); expect(alice.page.url()).toBe(alice.entry)
  await alice.page.getByRole('treeitem').filter({ has: alice.page.getByText('COMMUNITY_TITLE', { exact: true }) }).last().click()
  await alice.page.locator('p').filter({ hasText: 'COMMUNITY_MODEL_READY' }).last().waitFor()
  const patch = join(dshWebProfilePath(join(root, 'users', 'alice', 'home')), DSH_PATCH_CONFIG)
  const original = await readFile(patch)
  // Fixture fault injection: invalidate only Alice's persisted profile after a healthy native session.
  await writeFile(patch, 'broken-profile: true\n')
  const peerClosed = bob.closed(); expect(bob.opened()).toBeGreaterThan(0)
  await openCommunityAccountMenu(alice.page); await alice.page.getByRole('menuitem', { name: 'Restart instance', exact: true }).click()
  await alice.page.getByRole('checkbox').check(); await alice.page.getByRole('button', { name: 'Restart instance', exact: true }).click()
  await alice.page.getByRole('status').filter({ hasText: 'Restart failed.' }).waitFor({ timeout: 300_000 })
  expect((await alice.context.request.get(alice.entry, { maxRedirects: 0 })).status()).toBe(503)
  await alice.page.goto(`${origin}/recovery`); await alice.page.getByRole('heading', { name: 'Instance recovery' }).waitFor()
  expect((await alice.context.request.post(`${origin}/recovery/restart`, { data: { confirmed: true, username: 'bob' }, headers: { origin } })).status()).toBe(400)
  const freshDevice = await newValidationContext(browser); const recoveredPage = await validationPage(freshDevice)
  await recoveredPage.goto(`${origin}/login`)
  await recoveredPage.getByLabel('Username', { exact: true }).fill('alice')
  await recoveredPage.getByLabel('Password', { exact: true }).fill('password')
  await recoveredPage.getByRole('button', { name: 'Sign in', exact: true }).click()
  await recoveredPage.waitForURL(`${origin}/recovery`)
  await recoveredPage.getByRole('heading', { name: 'Instance recovery' }).waitFor()
  // Restore the same saved profile; the member can now retry the failed operation.
  await writeFile(patch, original)
  await recoveredPage.getByRole('checkbox').check(); await recoveredPage.getByRole('button', { name: 'Restart instance', exact: true }).click()
  await recoveredPage.getByRole('status').filter({ hasText: 'Instance restarted.' }).waitFor({ timeout: 300_000 })
  await recoveredPage.getByRole('link', { name: 'Return to DSH', exact: true }).click(); expect(recoveredPage.url()).toBe(alice.entry)
  await recoveredPage.getByRole('treeitem').filter({ has: recoveredPage.getByText('COMMUNITY_TITLE', { exact: true }) }).last().click()
  await recoveredPage.locator('p').filter({ hasText: 'COMMUNITY_MODEL_READY' }).last().waitFor()
  await runCommunityTerminal(recoveredPage, 'cat keep-project.txt "$HOME/keep-home.txt"', 'KEEP_PROJECTKEEP_HOME')
  expect(bob.closed()).toBe(peerClosed)
  await runCommunityTerminal(bob.page, "printf 'PEER_%s' READY", 'PEER_READY')
  await recoveredPage.goto(`${origin}/recovery`); await recoveredPage.getByRole('button', { name: 'Log out', exact: true }).click()
  await recoveredPage.waitForURL(`${origin}/login`)
  expect((await freshDevice.request.get(`${origin}/recovery`, { maxRedirects: 0 })).headers().location).toBe('/login')
  // Keep the terminal helper exercised after a restart as well as on first entry.
  await sendCommunityTerminal(bob.page, "printf 'PEER_%s' RETAINED", 'PEER_RETAINED')
}, 600_000)
