// Validation: T2; real credentials: none; installed rootless DSH, also manual pinned development DSH.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium, type Browser } from 'playwright'
import { afterEach, expect, it } from 'vitest'
import type { CommunityApplication } from '../src/ports/community-application.js'
import type { CommunityRuntimeConfig } from '../src/domain/community-config.js'
import type { CommunityInstanceResourceMember } from '../src/domain/admin-contract.js'
import { readBootstrapCredential } from '../src/adapters/bootstrap-credential.js'
import { CommunityRuntimeDriver } from '../src/adapters/community-runtime-driver.js'
import { candidateApplication } from './support/candidate-application.js'
import { runtimeSettings } from './support/real-dsh-kit.js'
import { assertPinnedDshRevision, runtimeSection } from './support/real-dsh-runtime.js'
import { newValidationContext, saveBrowserEvidence } from './fixtures/browser-evidence.js'
import { signInCommunity } from './fixtures/community-native-browser.js'

let root: string | undefined, app: CommunityApplication | undefined, browser: Browser | undefined, runtime: CommunityRuntimeConfig | undefined
afterEach(async test => {
  const errors: unknown[] = []; let rebuilt = false
  for (const action of [() => saveBrowserEvidence(test), () => browser?.close(), () => app?.stop(), async () => { if (runtime) await new CommunityRuntimeDriver(runtime).rebuild(); rebuilt = true }, async () => { if (root && rebuilt) await rm(root, { recursive: true, force: true }) }]) {
    try { await action() } catch (error) { errors.push(error) }
  }
  if (errors.length) throw new AggregateError(errors, 'Resident instance acceptance cleanup failed')
})

it('automatically starts resident members before navigation, restores them after platform restart and respects disable/enable', async () => {
  if (runtimeSettings.containerImage ? process.platform !== 'linux' || process.getuid?.() === 0 : !runtimeSettings.dshRoot) throw new Error('Actual rootless Linux DSH or pinned development DSH is required')
  if (process.env.DSH_PHALANX_INSTALL_ROOT && !runtimeSettings.containerImage) throw new Error('Installed acceptance requires the actual rootless container image')
  assertPinnedDshRevision(runtimeSettings)
  root = await mkdtemp(join(tmpdir(), 'resident-instances-'))
  runtime = runtimeSection(root, 'http://127.0.0.1:1', runtimeSettings)
  const config = { listen: { host: '127.0.0.1', port: 0 }, idleReclaimSeconds: 0, sessionSecret: 'resident-native-secret-at-least-32-bytes', runtime }
  app = candidateApplication(config); let origin = await app.start()
  browser = await chromium.launch({ headless: true })
  const adminContext = await newValidationContext(browser, { locale: 'en' }), admin = await adminContext.newPage()
  await admin.goto(`${origin}/bootstrap#credential=${readBootstrapCredential(root)!.credential}`)
  await admin.getByLabel('Username', { exact: true }).fill('admin'); await admin.getByLabel('Password', { exact: true }).fill('password')
  await admin.getByRole('button', { name: 'Create administrator', exact: true }).click(); await admin.waitForURL(`${origin}/admin`)
  expect((await adminContext.request.post(origin + '/admin/api/accounts', { headers: { origin }, data: { username: 'member', email: 'member@example.test', password: 'password' } })).status()).toBe(201)
  const member = async () => (await (await adminContext.request.get(origin + '/admin/api/instance-resources?username=member')).json()) as CommunityInstanceResourceMember
  const ownership = createHash('sha256').update(root).digest('hex')
  const carriers = async () => {
    if (!runtimeSettings.containerImage) { const key = (await member()).instanceKey; return key === null ? [] : [key] }
    return execFileSync(runtimeSettings.containerRuntimeCli, ['ps', '--filter', `label=dsh-phalanx.community-root=${ownership}`, '--filter', 'label=dsh-phalanx.user=member', '--format', '{{.ID}}'], { encoding: 'utf8' }).trim().split('\n').filter(Boolean)
  }
  expect((await carriers())).toEqual([])
  await admin.getByRole('button', { name: 'Edit member', exact: true }).click()
  const drawer = admin.getByRole('dialog', { name: 'Edit account: member', exact: true })
  await drawer.getByText('Resident instance', { exact: true }).click()
  await drawer.getByText('Restarting the platform interrupts tasks in resident instances.', { exact: true }).waitFor()
  await drawer.getByRole('button', { name: 'Save changes', exact: true }).click(); await drawer.waitFor({ state: 'detached' })
  // No member has signed in: readiness and the real carrier must come from the automatic queue.
  await expect.poll(async () => (await member()).instanceKey, { timeout: 120_000 }).not.toBeNull()
  expect((await carriers())).toHaveLength(1); const first = (await carriers())[0]!
  const context = await newValidationContext(browser, { locale: 'en' }), page = await context.newPage()
  await signInCommunity(page, origin, 'member', 'password'); expect((await carriers())).toEqual([first])
  await app.stop()
  app = candidateApplication({ ...config, idleReclaimSeconds: 999 }); origin = await app.start()
  await signInCommunity(admin, origin, 'admin', 'password', true)
  expect((await (await adminContext.request.get(origin + '/admin/api/instance-resources')).json()).idleSeconds).toBe(0)
  await expect.poll(async () => (await member()).instanceKey, { timeout: 120_000 }).not.toBeNull()
  expect((await carriers())).toHaveLength(1); expect((await carriers())[0]).not.toBe(first); const second = (await carriers())[0]!
  await signInCommunity(page, origin, 'member', 'password'); expect((await carriers())).toEqual([second])
  const accountAction = async (disabled: boolean) => {
    expect((await adminContext.request.post(origin + '/admin/api/accounts/member/actions', { headers: { origin }, data: { action: 'set-disabled', disabled } })).status()).toBe(200)
  }
  await accountAction(true); expect((await carriers())).toEqual([]); expect((await member()).resident).toBe(true)
  await accountAction(false)
  await expect.poll(async () => (await member()).instanceKey, { timeout: 120_000 }).not.toBeNull()
  expect((await carriers())).toHaveLength(1); expect((await carriers())[0]).not.toBe(second)
})
