// Validation: T4 integration; real credentials: none; official npm package on installed Linux artifacts.
import { mkdtemp, readFile } from 'node:fs/promises'
import { networkInterfaces, tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { chromium, type Page } from 'playwright'
import { expect, it, onTestFinished } from 'vitest'
import { readBootstrapCredential } from '../src/adapters/bootstrap-credential.js'
import { CommunityRuntimeDriver } from '../src/adapters/community-runtime-driver.js'
import { FileExecutionArtifacts } from '../src/adapters/execution-artifacts.js'
import { DSH_PROFILE_LOCK, dshWebProfilePath } from '../src/dsh/profile-layout.js'
import { startCommunityModel } from './fixtures/community-model.js'
import {
  openCommunitySidebar,
  openNativeSettings,
  runCommunityTerminal,
  sendCommunityPrompt,
  signInCommunity,
  startCommunitySession,
} from './fixtures/community-native-browser.js'
import { removeCommunityFixture } from './fixtures/owned-cleanup.js'
import { seedTestSecrets, withTestDatabase } from './support/community-application.js'
import { runtimeSettings } from './support/real-dsh-kit.js'
import { cookieHeader, createRealDshRpc } from './support/real-dsh-rpc.js'
import { assertPinnedDshRevision, memberHomePath, runtimeSection } from './support/real-dsh-runtime.js'
import { validationDownloadSelection } from './support/validation-downloads.js'

const packageName = 'billion-context'
const version = '0.1.216'
const integrity = 'sha512-98Q5eSqk0LyemCJ45OrYmZvEd0qpzBjLokthZlQ4yA7yvgUlzuM7fp6iq9dPAJ4N4vaplnvZeld0JxM4S7Ti1A=='
const password = 'fixture-only-password'
const rpc = createRealDshRpc()
type Application = Awaited<ReturnType<typeof import('../src/composition/community-application.js').createCommunityApplication>>

async function fixture() {
  const installed = process.env.DSH_PHALANX_INSTALL_ROOT
  const commit = process.env.DSH_PHALANX_CANDIDATE_SHA
  if (!installed || !commit || process.platform !== 'linux' || !runtimeSettings.containerImage)
    throw Error('Use installed Linux artifacts for billion-context acceptance')
  const build = JSON.parse(await readFile(join(installed, 'build-info.json'), 'utf8'))
  expect(build).toMatchObject({ commit, platform: `linux/${process.arch === 'arm64' ? 'arm64' : 'amd64'}` })
  assertPinnedDshRevision(runtimeSettings)
  const host = Object.values(networkInterfaces())
    .flat()
    .find(address => address?.family === 'IPv4' && !address.internal && /^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.)/u.test(address.address))?.address
  if (!host) throw Error('The installed development VM needs a private browser-facing address')
  const root = await mkdtemp(join(tmpdir(), 'community-billion-context-'))
  const owned: { application?: Application; browser?: Awaited<ReturnType<typeof chromium.launch>>; model?: Awaited<ReturnType<typeof startCommunityModel>> } =
    {}
  const runtime = runtimeSection(root, 'http://127.0.0.1:1', runtimeSettings)
  onTestFinished(async () => {
    try {
      await Promise.all([owned.browser?.close(), owned.model?.close()])
    } finally {
      try {
        await owned.application?.stop()
      } finally {
        await new CommunityRuntimeDriver(runtime).rebuild()
        try {
          await new FileExecutionArtifacts(join(root, 'runtime-dependencies', '.trees')).collect([])
        } finally {
          await removeCommunityFixture(root)
        }
      }
    }
  })
  const model = (owned.model = await startCommunityModel())
  const config = withTestDatabase({
    listen: { host, port: 0 },
    network: { hostPublicAddresses: [] },
    runtime: runtimeSection(root, model.origin, runtimeSettings),
    downloadSources: validationDownloadSelection(),
  })
  await seedTestSecrets({ ...config, modelGateway: { upstreamApiKey: 'community-provider-fixture-key' } }, installed)
  const { createCommunityApplication } = (await import(
    pathToFileURL(join(installed, 'dist/composition/community-application.js')).href
  )) as typeof import('../src/composition/community-application.js')
  const application = (owned.application = createCommunityApplication(config))
  const launched = (owned.browser = await chromium.launch({ headless: true }))
  const origin = (await application.start()).toString()
  const admin = await launched.newPage({ locale: 'en' })
  expect(readBootstrapCredential(root)).toBeDefined()
  const bootstrap = await admin.request.post(origin + '/bootstrap', {
    headers: { origin },
    form: { credential: readBootstrapCredential(root)!.credential, username: 'admin', password },
    maxRedirects: 0,
  })
  expect(bootstrap.status()).toBe(303)
  const api = async <T>(path: string, data?: object): Promise<T> => {
    const url = origin + '/admin/api/' + path
    const response = data ? await admin.request.post(url, { headers: { origin }, data }) : await admin.request.get(url)
    expect(response.ok(), `${path} HTTP ${response.status()}`).toBe(true)
    return response.json()
  }
  const member = async (username: string) => {
    const account = await api<{ groupId: string; spaceId: string }>('accounts', { username, password, email: '' })
    const context = await launched.newContext({ locale: 'en' })
    const page = await context.newPage()
    await signInCommunity(page, origin, username, password)
    return { page, account, username }
  }
  const restart = async (page: Page, username: string) => {
    const response = await page.request.post(origin + '/recovery/restart', { headers: { origin }, data: { confirmed: true }, timeout: 180_000 })
    expect(response.status()).toBe(200)
    await signInCommunity(page, origin, username, password)
  }
  return { root, origin, member, restart, launched, model }
}

async function bundle(page: Page, origin: string) {
  const rows = await rpc.remoteRpc<{ name: string; installed: boolean; enabled: boolean; version?: string; source?: string }[]>(
    origin,
    await cookieHeader(page.context(), origin),
    'pluginManager/listBundles',
    {},
  )
  return rows.find(row => row.name === packageName)
}

async function nativeInstall(page: Page, spec: string) {
  await openCommunitySidebar(page)
  await page.getByRole('button', { name: 'Plugins', exact: true }).click()
  await page.locator('[data-plugin-panel]').getByRole('button', { name: 'Add plugin', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Add plugin', exact: true })
  await dialog.getByRole('textbox', { name: 'Package name or address', exact: true }).fill(spec)
  const installed = page.getByRole('dialog', { name: 'Installed', exact: true })
  const failed = page.getByRole('dialog', { name: /^(The plugin could not be installed|Cannot access GitHub|GitHub connection timed out)$/u })
  const alert = dialog.getByRole('alert')
  const inspection = page.waitForResponse(response => new URL(response.url()).pathname.endsWith('/api/pluginManager/inspect'), { timeout: 90_000 })
  const inspectedOrBlocked = Promise.race([
    inspection.catch(() => undefined),
    installed
      .or(failed)
      .or(alert)
      .first()
      .waitFor({ timeout: 90_000 })
      .then(
        () => undefined,
        () => undefined,
      ),
  ])
  await dialog.getByRole('button', { name: 'Install', exact: true }).click()
  const inspected = await inspectedOrBlocked
  if (!inspected && !(await installed.isVisible())) {
    const phase = (await failed.isVisible()) ? 'failure dialog' : (await alert.isVisible()) ? 'input refused' : 'no inspection response'
    throw Error(`DSH native inspection did not finish for ${spec}: ${phase}`)
  }
  if (inspected?.ok()) {
    const payload = (await inspected.json().catch(() => undefined)) as
      { result?: { ok: boolean; value?: { status: string; problem?: string }; error?: { code?: string } } } | undefined
    const result = payload?.result
    if (!result) throw Error('DSH native inspection returned an invalid response')
    if (!result.ok || result.value?.status !== 'accepted') {
      const code = result.error?.code ?? result.value?.problem
      const classification = typeof code === 'string' && code.length <= 64 && /^[a-z0-9]+(?:[/-][a-z0-9]+)*$/u.test(code) ? code : 'unknown'
      throw Error(`DSH native inspection refused ${spec}: ${classification}`)
    }
  } else if (inspected) throw Error(`DSH native inspection failed with HTTP ${inspected.status()}`)
  await installed.or(failed).waitFor({ timeout: 660_000 })
  expect(await installed.isVisible(), `DSH native install did not finish for ${spec}`).toBe(true)
  await installed.getByRole('button', { name: 'Enable now', exact: true }).click()
  await installed.waitFor({ state: 'hidden' })
}

async function openBili(page: Page) {
  await openNativeSettings(page)
  const settings = page.getByRole('dialog', { name: 'Settings', exact: true })
  await settings.getByText('bili', { exact: true }).click({ timeout: 30_000 })
  return settings
}

const panelName = 'billion-context compression proxy'

it('opens the stock billion-context panel remotely only through the opted-in member space', async () => {
  const { root, origin, member, restart, launched, model } = await fixture()
  console.info('billion-context browser uses the development VM private address')
  const owner = await member('bili-owner')
  const peer = await member('bili-peer')
  await nativeInstall(owner.page, packageName + '@^' + version)
  await restart(owner.page, owner.username)
  expect(await bundle(owner.page, origin)).toMatchObject({ installed: true, enabled: true, version, source: expect.stringContaining(packageName) })
  const home = await memberHomePath(root, owner.username)
  expect(await readFile(join(dshWebProfilePath(home), DSH_PROFILE_LOCK), 'utf8')).toContain(integrity)

  const space = '/app/' + owner.account.spaceId
  const discovery = origin + space + '/bili/origin'
  const probe = async () => {
    const response = await owner.page.request.get(discovery, { maxRedirects: 0 })
    return response.ok() ? await response.json() : { httpStatus: response.status() }
  }
  const settings = await openBili(owner.page)
  await expect.poll(probe, { timeout: 60_000 }).toMatchObject({ origin: expect.stringMatching(/^https?:\/\/127\.0\.0\.1:\d+$/u) })
  await settings.getByText(/This page is reached through a remote address/u).waitFor({ timeout: 30_000 })
  expect(await settings.locator(`iframe[title="${panelName}"]`).count()).toBe(0)
  console.info(JSON.stringify({ discovery, defaultSidecar: await probe() }))

  await owner.page.keyboard.press('Escape')
  const enableRelay = [
    'const fs = require("node:fs"), path = require("node:path"), env = process.env;',
    'const home = path.resolve(env.HOME);',
    'const configHome = env.XDG_CONFIG_HOME || path.join(home, ".config");',
    'const file = path.resolve(env.BILI_CONFIG_FILE || path.join(configHome, "billion-context/billion-context.json"));',
    'if (!file.startsWith(home + path.sep)) throw Error("Expected a member-owned config path");',
    'const config = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};',
    'config.security = { ...config.security, adminRelay: true };',
    'fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });',
    'fs.writeFileSync(file, JSON.stringify(config, null, 2) + "\\n", { mode: 0o600 });',
  ].join(' ')
  await runCommunityTerminal(owner.page, `node -e '${enableRelay}' && printf 'BILI_RELAY_%s' READY`, 'BILI_RELAY_READY')
  await expect.poll(probe, { timeout: 60_000 }).toMatchObject({ relay: true })
  const session = await startCommunitySession(owner.page)
  await sendCommunityPrompt(owner.page, 'IMAGE_TASK for the billion-context isolation fixture.')
  await owner.page.getByText('IMAGE_SEEN', { exact: true }).waitFor({ timeout: 90_000 })
  expect(model.requests.length).toBeGreaterThan(0)
  const statusUrl = origin + space + '/__bili/plugin/status?conversationId=' + encodeURIComponent(session) + '&fallback=latest'
  const status = async () => {
    const response = await owner.page.request.get(statusUrl, { maxRedirects: 0 })
    return response.ok() ? ((await response.json()) as { sessionId?: string }) : { httpStatus: response.status() }
  }
  await expect.poll(status, { timeout: 45_000 }).toMatchObject({ ok: true, conversationId: session, sessionId: expect.any(String) })
  const readback = await status()
  const sessionId = 'sessionId' in readback ? readback.sessionId : undefined
  expect(sessionId).toBeTruthy()
  const sessionHash = '#/session/' + encodeURIComponent(sessionId!)

  const assertPanel = async () => {
    const panel = await openBili(owner.page)
    const frame = panel.locator(`iframe[title="${panelName}"]`)
    await frame.waitFor({ timeout: 45_000 })
    const url = new URL((await frame.getAttribute('src'))!, origin)
    expect(url.origin).toBe(origin)
    expect(url.pathname).toBe(space + '/__bili/')
    expect(url.hash).toBe('#/overview')
    const overview = frame.contentFrame().locator('#page-overview')
    await overview.locator('[data-i18n="ov.gross_saved"]').waitFor({ timeout: 30_000 })
    await expect.poll(() => overview.locator('#st-reqs').textContent()).toMatch(/[1-9]/u)
    await panel.getByRole('button', { name: 'Sessions', exact: true }).click()
    await expect.poll(() => frame.getAttribute('src')).toMatch(/#\/sessions$/u)
    await frame
      .contentFrame()
      .locator(`#sessions-body a[href=${JSON.stringify(sessionHash)}]`)
      .waitFor({ timeout: 30_000 })
    return url
  }
  const first = await assertPanel()
  console.info(JSON.stringify({ memberPanel: first.href }))
  const checked = [discovery, first.href, statusUrl, origin + space + '/__bili/sessions']
  const anonymous = await launched.newContext({ locale: 'en' })
  for (const url of checked) {
    expect([401, 403]).toContain((await peer.page.request.get(url, { maxRedirects: 0 })).status())
    expect([302, 303, 401, 403]).toContain((await anonymous.request.get(url, { maxRedirects: 0 })).status())
  }
  await anonymous.close()
  const peerProbe = await peer.page.request.get(origin + '/app/' + peer.account.spaceId + '/bili/origin', { maxRedirects: 0 })
  if (peerProbe.ok() && peerProbe.headers()['content-type']?.includes('application/json')) {
    expect(await peerProbe.json()).not.toMatchObject({ relay: true })
  }
  await owner.page.keyboard.press('Escape')
  await owner.page.getByRole('dialog', { name: 'Settings', exact: true }).waitFor({ state: 'hidden' })
  const contextTab = owner.page.getByRole('tab', { name: 'Context', exact: true })
  const moreViews = owner.page.getByRole('button', { name: 'More conversation views', exact: true })
  await contextTab.or(moreViews).first().waitFor()
  if (await contextTab.isVisible()) {
    await contextTab.click()
  } else {
    await moreViews.click()
    await owner.page.getByRole('menuitem', { name: 'Context', exact: true }).click()
  }
  const sessionFrame = owner.page.locator(`iframe[title="${panelName}"]:visible`)
  await sessionFrame.waitFor({ timeout: 45_000 })
  const sessionUrl = new URL((await sessionFrame.getAttribute('src'))!, origin)
  expect(sessionUrl.pathname).toBe(space + '/__bili/')
  expect(sessionUrl.hash).toBe(sessionHash)
  const detail = sessionFrame.contentFrame().locator('#session-detail-view')
  await detail
    .getByText(/^Context(?:\s|:|$)/u)
    .first()
    .waitFor({ timeout: 30_000 })
  await owner.page.reload()
  await assertPanel()
  await restart(owner.page, owner.username)
  await assertPanel()
  console.info('Stock 0.1.216 remote overview, sessions, context, reload, restart and member access checks passed')
}, 1_200_000)
