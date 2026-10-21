// Validation: T2; real credentials: none; installed rootless DSH and actual browser navigation.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium, type Browser } from 'playwright'
import { afterEach, expect, it } from 'vitest'
import { candidateApplication } from './support/candidate-application.js'
import { CommunityAccountStore } from '../src/adapters/community-account-store.js'
import { CommunityRuntimeDriver } from '../src/adapters/community-runtime-driver.js'
import type { CommunityApplication } from '../src/ports/community-application.js'
import type { CommunityRuntimeConfig } from '../src/domain/community-config.js'
import { runtimeSettings } from './support/real-dsh-kit.js'
import { assertPinnedDshRevision, runtimeSection } from './support/real-dsh-runtime.js'
import { cookieHeader } from './support/real-dsh-rpc.js'
import { communityEntryUrl } from './support/community-space.js'
import { newValidationContext, saveBrowserEvidence } from './fixtures/browser-evidence.js'

let root: string | undefined, app: CommunityApplication | undefined, browser: Browser | undefined, runtime: CommunityRuntimeConfig | undefined
let release: () => void = () => {}
afterEach(async test => {
  release(); await saveBrowserEvidence(test); await browser?.close(); await app?.stop()
  if (runtime) await new CommunityRuntimeDriver(runtime).rebuild()
  if (root) await rm(root, { recursive: true, force: true })
})
it('enters one native carrier from concurrent bookmarked overlays and re-enters after actual idle reclamation', async () => {
  if (process.platform !== 'linux' || process.getuid?.() === 0 || !runtimeSettings.containerImage) throw new Error('Actual rootless Linux DSH is required')
  assertPinnedDshRevision(runtimeSettings)
  root = await mkdtemp(join(tmpdir(), 'community-startup-'))
  runtime = runtimeSection(root, 'http://127.0.0.1:1', runtimeSettings)
  app = candidateApplication({ listen: { host: '127.0.0.1', port: 0 }, idleReclaimSeconds: 5,
    sessionSecret: 'startup-native-fixture-secret-at-least-32-bytes', runtime })
  const accounts = new CommunityAccountStore(join(root, 'community-accounts.db'))
  try { await accounts.create({ username: 'member', email: '', password: 'password' }) } finally { accounts.close() }
  const origin = await app.start()
  const ownership = createHash('sha256').update(root).digest('hex')
  const carriers = () => execFileSync(runtimeSettings.containerRuntimeCli, ['ps', '--filter', `label=dsh-phalanx.community-root=${ownership}`, '--format', '{{.ID}}'], { encoding: 'utf8' }).trim().split('\n').filter(Boolean)
  browser = await chromium.launch({ headless: true })
  const context = await newValidationContext(browser, { viewport: { width: 390, height: 844 } })
  const login = await context.request.post(origin + '/login', { headers: { origin }, form: { username: 'member', password: 'password' }, maxRedirects: 0 })
  expect(login.status()).toBe(303); expect(carriers()).toEqual([])
  const entry = communityEntryUrl(origin, await cookieHeader(context, origin)), bookmark = entry + '?view=workspace#saved'
  expect(login.headers().location).toBe(new URL(entry).pathname)
  let unblock!: () => void
  const gate = new Promise<void>(resolve => { unblock = resolve }); release = unblock
  await context.route('**/account/startup', async route => { await gate; await route.continue().catch(() => {}) })
  const pages = await Promise.all([context.newPage(), context.newPage()])
  const nativeAssets: string[] = []
  for (const page of pages) page.on('request', request => { if (['script', 'stylesheet'].includes(request.resourceType())) nativeAssets.push(request.url()) })
  await Promise.all(pages.map(async page => {
    await page.goto(bookmark)
    await page.locator('[data-platform-startup]').waitFor()
    expect(page.url()).toBe(bookmark)
    expect(await page.locator('#root').count()).toBe(0)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  }))
  expect(nativeAssets).toEqual([])
  await expect.poll(async () => (await (await context.request.get(origin + '/account/startup')).json() as { state: string }).state, { timeout: 300_000 }).toBe('ready')
  const first = carriers(); expect(first).toHaveLength(1)
  unblock(); await context.unroute('**/account/startup')
  await Promise.all(pages.map(async page => {
    await page.locator('#root').waitFor({ state: 'attached', timeout: 60_000 })
    await page.getByRole('button', { name: /^Platform account:/u }).waitFor()
    expect(page.url()).toBe(bookmark)
  }))
  expect(nativeAssets.length).toBeGreaterThan(0); expect(carriers()).toEqual(first)
  await Promise.all(pages.map(page => page.close()))
  await expect.poll(carriers, { timeout: 60_000 }).toEqual([])
  const returned = await context.newPage()
  await returned.goto(bookmark); await returned.locator('[data-platform-startup]').waitFor()
  expect(returned.url()).toBe(bookmark)
  await returned.locator('#root').waitFor({ state: 'attached', timeout: 300_000 })
  await returned.getByRole('button', { name: /^Platform account:/u }).waitFor()
  expect(returned.url()).toBe(bookmark)
  const next = carriers(); expect(next).toHaveLength(1); expect(next[0]).not.toBe(first[0])
}, 600_000)
