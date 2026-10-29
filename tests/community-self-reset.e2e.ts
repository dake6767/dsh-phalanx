// Validation: T2; real credentials: none; installed rootless DSH; also manual pinned development DSH.
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium, type Browser } from 'playwright'
import { afterEach, expect, it } from 'vitest'
import { readBootstrapCredential } from '../src/adapters/bootstrap-credential.js'
import { CommunityRuntimeDriver } from '../src/adapters/community-runtime-driver.js'
import type { CommunityEnvironmentResetResult } from '../src/domain/admin-contract.js'
import type { CommunityRuntimeConfig } from '../src/domain/community-config.js'
import { effectiveUserDataRoot } from '../src/domain/storage-layout.js'
import { DSH_PATCH_CONFIG, dshWebProfilePath } from '../src/dsh/profile-layout.js'
import type { CommunityApplication } from '../src/ports/community-application.js'
import { newValidationContext, saveBrowserEvidence } from './fixtures/browser-evidence.js'
import { startCommunityModel } from './fixtures/community-model.js'
import {
  openCommunityAccountMenu,
  openCommunitySession,
  runCommunityTerminal,
  selectCommunityWorkspace,
  sendCommunityPrompt,
  signInCommunity,
  startCommunitySession,
} from './fixtures/community-native-browser.js'
import { removeCommunityFixture } from './fixtures/owned-cleanup.js'
import { candidateApplication } from './support/candidate-application.js'
import { selectBuiltinDatabase } from './support/community-bootstrap-browser.js'
import { runtimeSettings } from './support/real-dsh-kit.js'
import { assertPinnedDshRevision, defaultWorkspacePath, instanceWorkspacePath, runtimeSection } from './support/real-dsh-runtime.js'

let root: string | undefined, app: CommunityApplication | undefined, browser: Browser | undefined, runtime: CommunityRuntimeConfig | undefined
let model: Awaited<ReturnType<typeof startCommunityModel>> | undefined
afterEach(async test => {
  const errors: unknown[] = []
  let rebuilt = false
  for (const action of [
    () => saveBrowserEvidence(test),
    () => model?.release(),
    () => browser?.close(),
    () => app?.stop(),
    async () => {
      if (runtime) await new CommunityRuntimeDriver(runtime).rebuild()
      rebuilt = true
    },
    () => model?.close(),
    async () => {
      if (root && rebuilt) await removeCommunityFixture(root)
    },
  ]) {
    try {
      await action()
    } catch (error) {
      errors.push(error)
    }
  }
  if (errors.length) throw new AggregateError(errors, 'Member self-reset acceptance cleanup failed')
})
it('resets through the native recovery link while preserving projects and chat, limits member retries and keeps three complete backups', async () => {
  if (runtimeSettings.containerImage ? process.platform !== 'linux' || process.getuid?.() === 0 : !runtimeSettings.dshRoot)
    throw Error('Actual rootless Linux DSH or pinned development DSH is required')
  if (process.env.DSH_PHALANX_INSTALL_ROOT && !runtimeSettings.containerImage) throw Error('Installed acceptance requires the actual rootless container image')
  assertPinnedDshRevision(runtimeSettings)
  root = await mkdtemp(join(tmpdir(), 'community-self-reset-'))
  model = await startCommunityModel()
  runtime = runtimeSection(root, model.origin, runtimeSettings)
  const containerMode = runtime.container !== undefined
  app = candidateApplication({
    listen: { host: '127.0.0.1', port: 0 },
    sessionSecret: 'member-self-reset-fixture-secret-at-least-32-bytes',
    runtime,
    modelGateway: { upstreamApiKey: 'community-provider-fixture-key' },
  })
  const origin = await app.start()
  browser = await chromium.launch({ headless: true })
  const adminContext = await newValidationContext(browser, { locale: 'en' }),
    admin = await adminContext.newPage()
  await admin.goto(`${origin}/bootstrap#credential=${readBootstrapCredential(root)!.credential}`)
  await selectBuiltinDatabase(admin)
  await admin.getByLabel('Username', { exact: true }).fill('admin')
  await admin.getByLabel('Password', { exact: true }).fill('password')
  await admin.getByRole('button', { name: 'Create administrator', exact: true }).click()
  await admin.waitForURL(`${origin}/admin`)
  expect(
    (
      await adminContext.request.post(origin + '/admin/api/accounts', {
        headers: { origin },
        data: { username: 'alice', email: 'alice@example.test', password: 'password' },
      })
    ).status(),
  ).toBe(201)
  const previous: CommunityEnvironmentResetResult[] = []
  for (let index = 0; index < 3; index++) {
    const response = await adminContext.request.post(origin + '/admin/api/accounts/alice/reset-environment', {
      headers: { origin },
      data: { confirmed: true },
      timeout: 120_000,
    })
    expect(response.status()).toBe(200)
    previous.push((await response.json()) as CommunityEnvironmentResetResult)
  }
  const memberContext = await newValidationContext(browser, { locale: 'en' }),
    page = await memberContext.newPage()
  await signInCommunity(page, origin, 'alice', 'password')
  const entry = page.url(),
    spaceId = previous[0]!.spaceId
  await selectCommunityWorkspace(memberContext, page, origin, instanceWorkspacePath(defaultWorkspacePath(root, 'alice'), containerMode), containerMode)
  await runCommunityTerminal(page, 'printf SELF_PROJECT > keep-project.txt; printf SELF_HOME > "$HOME/keep-home.txt"; printf FILES_SAVED', 'FILES_SAVED')
  const session = await startCommunitySession(page)
  await sendCommunityPrompt(page, 'KEEP_SELF_RESET_CHAT')
  await page.getByText('COMMUNITY_', { exact: true }).waitFor()
  model.release()
  await page.locator('p').filter({ hasText: 'COMMUNITY_MODEL_READY' }).last().waitFor()
  await openCommunityAccountMenu(page)
  await page.getByRole('menuitem', { name: 'More recovery options', exact: true }).click()
  await page.waitForURL(origin + '/recovery')
  await page.route('**/admin/assets/**', route => route.abort())
  expect(await page.locator('script[src]').count()).toBe(0)
  const home = join(effectiveUserDataRoot({ dataRoot: root }), 'alice/home'),
    patch = join(dshWebProfilePath(home), DSH_PATCH_CONFIG)
  await writeFile(patch, 'broken-self-profile: true\n')
  const form = page.locator('#reset-environment')
  await form.getByRole('checkbox').check()
  const completed = page.waitForResponse(response => new URL(response.url()).pathname === '/recovery/reset')
  await form.getByRole('button', { name: 'Reset environment', exact: true }).click()
  const response = await completed
  expect(response.status()).toBe(200)
  expect(await response.json()).toEqual({ entry: new URL(entry).pathname })
  await page.locator('#reset-status').filter({ hasText: 'DSH environment reset.' }).waitFor()
  const parent = join(effectiveUserDataRoot({ dataRoot: root }), '_environment-backups', spaceId),
    backups = await readdir(parent)
  expect(backups).toHaveLength(3)
  expect(backups).not.toContain(previous[0]!.backup.id)
  const current = backups.filter(id => !previous.some(row => row.backup.id === id))
  expect(current).toHaveLength(1)
  expect(await readFile(join(parent, current[0]!, 'files/.dsh/profiles/web/cordis.patch.yml'), 'utf8')).toBe('broken-self-profile: true\n')
  expect(await readFile(patch, 'utf8')).not.toContain('broken-self-profile')
  await form.getByRole('button', { name: 'Reset environment', exact: true }).click()
  await expect.poll(() => page.locator('#reset-status').textContent()).toMatch(/Wait \d+ seconds/u)
  expect(await page.locator('#reset-status').textContent()).not.toContain(root)
  await page.getByRole('link', { name: 'Return to DSH', exact: true }).click()
  await page.getByRole('button', { name: /^Platform account:/u }).waitFor()
  await selectCommunityWorkspace(memberContext, page, origin, instanceWorkspacePath(defaultWorkspacePath(root, 'alice'), containerMode), containerMode)
  await openCommunitySession(page, session)
  await page.locator('p').filter({ hasText: 'COMMUNITY_MODEL_READY' }).last().waitFor()
  await runCommunityTerminal(page, 'cat keep-project.txt "$HOME/keep-home.txt"', 'SELF_PROJECTSELF_HOME')
  await admin.goto(origin + '/admin/accounts')
  await admin.getByRole('button', { name: 'Edit alice', exact: true }).click()
  await admin
    .getByRole('dialog', { name: 'Edit account: alice', exact: true })
    .getByText(/^Requested by member alice at /u)
    .waitFor()
})
