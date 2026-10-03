import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium, type Browser } from 'playwright'
import { afterEach, expect, it } from 'vitest'
import { readBootstrapCredential } from '../src/adapters/bootstrap-credential.js'
import { startCommunityModel } from './fixtures/community-model.js'
import { signInCommunity, selectCommunityWorkspace } from './fixtures/community-native-browser.js'
import { newValidationContext, saveBrowserEvidence } from './fixtures/browser-evidence.js'
import { assertPinnedDshRevision, defaultWorkspacePath } from './support/real-dsh-runtime.js'
import { runtimeSettings } from './support/real-dsh-kit.js'

let root: string | undefined, child: ChildProcess | undefined, exited: Promise<void> | undefined
let browser: Browser | undefined, model: Awaited<ReturnType<typeof startCommunityModel>> | undefined
afterEach(async test => {
  await saveBrowserEvidence(test)
  model?.release()
  await browser?.close()
  if (child?.pid !== undefined && child.exitCode === null && child.signalCode === null) process.kill(-child.pid, 'SIGTERM')
  await exited
  await model?.close()
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined; child = undefined; exited = undefined; browser = undefined; model = undefined
})

it('starts the documented development command and supplies a member native streaming and cancellation', async () => {
  if (runtimeSettings.dshRoot === undefined || runtimeSettings.containerImage !== undefined || process.platform === 'win32') {
    throw new Error('This acceptance requires pinned development DSH on a POSIX host')
  }
  assertPinnedDshRevision(runtimeSettings)
  root = await mkdtemp(join(tmpdir(), 'dsh-phalanx-development-'))
  model = await startCommunityModel()
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('DSH_PHALANX_')))
  child = spawn('corepack', ['pnpm', 'dev'], { detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...env,
    DSH_PHALANX_HOST: '127.0.0.1', DSH_PHALANX_PORT: '0', DSH_PHALANX_DATA_ROOT: root,
    DSH_PHALANX_SESSION_SECRET: 'development-cli-fixture-session-secret-32-bytes',
    DSH_PHALANX_RUNTIME_COMMAND: process.execPath,
    DSH_PHALANX_RUNTIME_ARGS_JSON: JSON.stringify([join(runtimeSettings.dshRoot, 'apps/cli/lib/bin.js'), '--profile', 'web']),
    DSH_PHALANX_ALLOWED_MODEL_PROVIDER: 'deepseek-official', DSH_PHALANX_ALLOWED_MODEL: 'deepseek-chat',
    DSH_PHALANX_MODEL_UPSTREAM_BASE_URL: model.origin,
    DSH_PHALANX_MODEL_UPSTREAM_API_KEY: 'community-provider-fixture-key',
  } })
  exited = new Promise(resolve => child!.once('close', () => resolve()))
  child.stderr?.resume()
  const origin = await new Promise<string>((resolve, reject) => {
    let output = ''
    child!.once('error', reject)
    child!.once('exit', () => reject(new Error('Development command exited before readiness')))
    child!.stdout?.on('data', data => {
      output += String(data)
      const match = /dsh-phalanx listening at (http:\/\/127\.0\.0\.1:\d+)/u.exec(output)
      if (match?.[1] !== undefined) resolve(match[1])
    })
  })
  const credential = readBootstrapCredential(root)!.credential
  const created = await fetch(`${origin}/bootstrap`, { method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ credential, username: 'admin', email: 'admin@example.test', password: 'admin-password' }) })
  expect(created.status).toBe(303)
  expect(readBootstrapCredential(root)).toBeUndefined()
  browser = await chromium.launch({ headless: true })
  const admin = await newValidationContext(browser)
  await signInCommunity(await admin.newPage(), origin, 'admin', 'admin-password', true)
  expect((await admin.request.post(`${origin}/admin/api/accounts`, {
    headers: { origin }, data: { username: 'member', email: 'member@example.test', password: 'member-password' } })).status()).toBe(201)
  await admin.close()
  const context = await newValidationContext(browser), page = await context.newPage()
  await signInCommunity(page, origin, 'member', 'member-password')
  await selectCommunityWorkspace(context, page, origin, defaultWorkspacePath(root, 'member'))
  const composer = page.locator('[data-composer-input]')
  await composer.fill('STREAM_MODEL_TASK: Reply with the deterministic marker.'); await composer.press('Enter')
  await page.getByText('COMMUNITY_', { exact: true }).waitFor({ timeout: 60_000 })
  expect(await page.getByText('COMMUNITY_MODEL_READY', { exact: true }).count()).toBe(0)
  model.release()
  await page.locator('p').filter({ hasText: 'COMMUNITY_MODEL_READY' }).first().waitFor({ timeout: 60_000 })
  await composer.fill('CANCEL_MODEL_TASK: Hold the reply until cancelled.'); await composer.press('Enter')
  await page.getByText('CANCEL_STARTED', { exact: true }).waitFor({ timeout: 60_000 })
  await page.getByRole('button', { name: 'Stop generating', exact: true }).click()
  await model.cancelled
  expect(await page.content()).not.toContain('community-provider-fixture-key')
})
