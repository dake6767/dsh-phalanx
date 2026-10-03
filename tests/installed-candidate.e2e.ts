import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium, type Browser } from 'playwright'
import { startPlatformCli } from './support/platform-cli.js'
import { afterEach, expect, it } from 'vitest'
import { readBootstrapCredential } from '../src/adapters/bootstrap-credential.js'
import { startCommunityModel } from './fixtures/community-model.js'
import { signInCommunity, selectCommunityWorkspace, runCommunityTerminal } from './fixtures/community-native-browser.js'
import { newValidationContext, saveBrowserEvidence } from './fixtures/browser-evidence.js'
import { assertPinnedDshRevision, defaultWorkspacePath, instanceWorkspacePath, CONTAINER_DSH_CLI } from './support/real-dsh-runtime.js'
import { runtimeSettings } from './support/real-dsh-kit.js'

let root: string | undefined, cli: Awaited<ReturnType<typeof startPlatformCli>> | undefined
let browser: Browser | undefined, model: Awaited<ReturnType<typeof startCommunityModel>> | undefined
afterEach(async test => {
  await saveBrowserEvidence(test)
  model?.release()
  await browser?.close()
  await cli?.stop()
  await model?.close()
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined; cli = undefined; browser = undefined; model = undefined
})

it('runs the downloaded platform with bundled Node and imported candidate DSH through native browser terminal and model streaming', async () => {
  const installed = process.env.DSH_PHALANX_INSTALL_ROOT
  const expectedCommit = process.env.DSH_PHALANX_CANDIDATE_SHA
  if (process.platform !== 'linux' || process.getuid?.() === 0 || installed === undefined || expectedCommit === undefined || runtimeSettings.containerImage === undefined) {
    throw new Error('Requires a verified Linux candidate installation, exact SHA and dedicated rootless image')
  }
  assertPinnedDshRevision(runtimeSettings)
  const buildInfo = JSON.parse(await readFile(join(installed, 'build-info.json'), 'utf8')) as { commit: string; platform: string }
  expect(buildInfo).toMatchObject({ commit: expectedCommit, platform: 'linux/amd64' })
  root = await mkdtemp(join(tmpdir(), 'dsh-phalanx-installed-'))
  model = await startCommunityModel()
  cli = await startPlatformCli(join(installed, 'start'), [], {
    DSH_PHALANX_HOST: '127.0.0.1', DSH_PHALANX_PORT: '0', DSH_PHALANX_DATA_ROOT: root,
    DSH_PHALANX_SESSION_SECRET: 'installed-fixture-session-secret-at-least-32-bytes',
    DSH_PHALANX_RUNTIME_COMMAND: 'node', DSH_PHALANX_RUNTIME_ARGS_JSON: JSON.stringify([CONTAINER_DSH_CLI, '--profile', 'web']),
    DSH_PHALANX_CONTAINER_RUNTIME: runtimeSettings.containerRuntimeCli, DSH_PHALANX_CONTAINER_IMAGE: runtimeSettings.containerImage,
    DSH_PHALANX_CONTAINER_GATEWAY_PORT: String(runtimeSettings.containerGatewayPort),
    DSH_PHALANX_HOST_PUBLIC_ADDRESSES: process.env.DSH_PHALANX_E2E_HOST_PUBLIC_ADDRESSES ?? '',
    DSH_PHALANX_ALLOWED_MODEL_PROVIDER: 'deepseek-official', DSH_PHALANX_ALLOWED_MODEL: 'deepseek-chat',
    DSH_PHALANX_MODEL_UPSTREAM_BASE_URL: model.origin, DSH_PHALANX_MODEL_UPSTREAM_API_KEY: 'community-provider-fixture-key',
  })
  const origin = cli.origin
  browser = await chromium.launch({ headless: true })
  const adminContext = await newValidationContext(browser), admin = await adminContext.newPage()
  await admin.goto(`${origin}/bootstrap`)
  await admin.getByLabel('Bootstrap credential').fill(readBootstrapCredential(root)!.credential)
  await admin.getByLabel('Username').fill('admin')
  await admin.getByLabel('Email').fill('admin@example.test')
  await admin.getByLabel('Password', { exact: true }).fill('admin-password')
  await admin.getByRole('button', { name: 'Create administrator' }).click()
  await admin.waitForURL(`${origin}/login`)
  await signInCommunity(admin, origin, 'admin', 'admin-password', true)
  await admin.getByRole('heading', { name: 'Account management' }).waitFor()
  expect((await adminContext.request.post(`${origin}/admin/api/accounts`, { headers: { origin },
    data: { username: 'member', email: 'member@example.test', password: 'member-password' } })).status()).toBe(201)
  const context = await newValidationContext(browser), member = await context.newPage()
  await signInCommunity(member, origin, 'member', 'member-password')
  await selectCommunityWorkspace(context, member, origin, instanceWorkspacePath(defaultWorkspacePath(root, 'member'), true), true)
  await runCommunityTerminal(member, "printf 'CANDIDATE_%s' 'TERMINAL_READY'", 'CANDIDATE_TERMINAL_READY')
  const composer = member.locator('[data-composer-input]')
  await composer.fill('STREAM_MODEL_TASK: Reply with the deterministic marker.'); await composer.press('Enter')
  await member.getByText('COMMUNITY_', { exact: true }).waitFor({ timeout: 60_000 })
  model.release()
  await member.locator('p').filter({ hasText: 'COMMUNITY_MODEL_READY' }).first().waitFor({ timeout: 60_000 })
  expect(await member.content()).not.toContain('community-provider-fixture-key')
})
