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
import { dshWebProfilePath, DSH_PATCH_CONFIG } from '../src/dsh/profile-layout.js'
import { SESSION_LIST } from '../src/dsh/session-protocol.js'
import { startCommunityModel } from './fixtures/community-model.js'
import { newValidationContext, saveBrowserEvidence } from './fixtures/browser-evidence.js'
import { signInCommunity, selectCommunityWorkspace, runCommunityTerminal, sendCommunityTerminal } from './fixtures/community-native-browser.js'
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
    await page.getByRole('link', { name: 'Restart instance', exact: true }).waitFor()
    worlds.push({ context, page, entry, closed: () => closed, opened: () => opened })
  }
  const alice = worlds[0]!; const bob = worlds[1]!
  await runCommunityTerminal(alice.page, "printf 'KEEP_PROJECT' > keep-project.txt; printf 'KEEP_HOME' > \"$HOME/keep-home.txt\"; printf 'FILES_%s' SAVED", 'FILES_SAVED')
  const otherDevice = await newValidationContext(browser)
  expect((await otherDevice.request.post(`${origin}/login`, { form: { username: 'alice', password: 'password' }, headers: { origin }, maxRedirects: 0 })).status()).toBe(303)
  const taskState = async () => await createBrowserDshRpc(otherDevice).remoteRpc<{ items: { running: boolean }[] }>(origin, await cookieHeader(otherDevice, origin), SESSION_LIST, { _request: {} })
  await alice.page.locator('[data-composer-input]').fill('STREAM_MODEL_TASK'); await alice.page.locator('[data-composer-input]').press('Enter')
  await alice.page.getByText('COMMUNITY_', { exact: true }).waitFor(); expect((await taskState()).items.some(row => row.running)).toBe(true)
  await alice.page.getByRole('button', { name: 'Log out', exact: true }).click(); await alice.page.waitForURL(`${origin}/login`)
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
  await alice.page.getByRole('link', { name: 'Restart instance', exact: true }).click()
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
