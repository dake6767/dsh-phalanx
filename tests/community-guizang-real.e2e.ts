// Validation: T4 integration; real credentials: none; live catalog and registry on installed Linux artifacts.
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { chromium, type Page } from 'playwright'
import { expect, it, onTestFinished } from 'vitest'
import { readBootstrapCredential } from '../src/adapters/bootstrap-credential.js'
import { CommunityRuntimeDriver } from '../src/adapters/community-runtime-driver.js'
import { FileExecutionArtifacts } from '../src/adapters/execution-artifacts.js'
import type { CommunityMarketPageData, CommunityPluginView, CommunitySuiteCatalogView } from '../src/domain/admin-contract.js'
import type { CommunityManagedGroupView } from '../src/domain/plugin-group-contract.js'
import { DSH_PROFILE_LOCK, dshHomePath, dshWebProfilePath } from '../src/dsh/profile-layout.js'
import { openCommunitySidebar, runCommunityTerminal, signInCommunity, startCommunitySession } from './fixtures/community-native-browser.js'
import { removeCommunityFixture } from './fixtures/owned-cleanup.js'
import { appCenterButton, appCenterPanel, setAppCenterVisibility } from './support/app-center-visibility.js'
import { seedTestSecrets, withTestDatabase, type CommunityApplicationOptions } from './support/community-application.js'
import { runtimeSettings } from './support/real-dsh-kit.js'
import { cookieHeader, createRealDshRpc } from './support/real-dsh-rpc.js'
import {
  assertPinnedDshRevision,
  CONTAINER_HOME,
  defaultWorkspacePath,
  instanceWorkspacePath,
  memberHomePath,
  runtimeSection,
} from './support/real-dsh-runtime.js'
import { validationDownloadSelection } from './support/validation-downloads.js'

const packageName = 'dsh-guizang-design'
const catalogVersion = '0.1.5001'
const catalogIntegrity = 'sha512-0mAJnqSWNiw+stjyjngVh/ZlSN+9qwpWQv5nZFRIgSGHbDufwYMC2pyZT3Ng/aPJRp/Hst7OriEFzl2mkkPhfA=='
const resolvedNpmIntegrity = 'sha512-f0RyjQ+sr3dw0Drhu1YXXUhx4oLp5m0rlQ1cIgtMXBNrUm4dNCO2NVjNLgHnKp+I0g7wObZ1+gv9Hbg74Z25bg=='
const nativeVersion = '0.1.5-phalanx.1'
const nativeArchiveFilename = `${packageName}-${nativeVersion}.tgz`
const nativeArchive = `https://github.com/dake6767/dsh-guizang-design/releases/download/v${nativeVersion}/${nativeArchiveFilename}`
const nativeArchiveDigest = '6b8658f454080faee6a5ec06e6c4e0f9d0903f3f8fd8e5a991c14598510f4b92'
const password = 'fixture-only-password'
const rpc = createRealDshRpc()
type Application = Awaited<ReturnType<typeof import('../src/composition/community-application.js').createCommunityApplication>>

async function fixture(options: CommunityApplicationOptions = {}) {
  const installed = process.env.DSH_PHALANX_INSTALL_ROOT
  const commit = process.env.DSH_PHALANX_CANDIDATE_SHA
  if (!installed || !commit || process.platform !== 'linux' || !runtimeSettings.containerImage)
    throw Error('Use installed Linux artifacts for Guizang acceptance')
  const build = JSON.parse(await readFile(join(installed, 'build-info.json'), 'utf8'))
  expect(build).toMatchObject({ commit, platform: `linux/${process.arch === 'arm64' ? 'arm64' : 'amd64'}` })
  assertPinnedDshRevision(runtimeSettings)
  const root = await mkdtemp(join(tmpdir(), 'community-guizang-'))
  const runtime = runtimeSection(root, 'http://127.0.0.1:1', runtimeSettings)
  const owned: { application?: Application; browser?: Awaited<ReturnType<typeof chromium.launch>> } = {}
  onTestFinished(async () => {
    try {
      await owned.browser?.close()
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
  const config = withTestDatabase({
    listen: { host: '127.0.0.1', port: 0 },
    network: { hostPublicAddresses: [] },
    runtime,
    downloadSources: validationDownloadSelection(),
  })
  await seedTestSecrets(config, installed)
  const { createCommunityApplication } = (await import(
    pathToFileURL(join(installed, 'dist/composition/community-application.js')).href
  )) as typeof import('../src/composition/community-application.js')
  const application = (owned.application = createCommunityApplication(config, options))
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
    await setAppCenterVisibility(admin.request, origin, account.groupId)
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
  return { root, api, origin, member, restart }
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

async function gallery(page: Page, origin: string) {
  await openCommunitySidebar(page)
  await page.getByText(/^(Guizang Design|歸藏设计)$/u).click()
  const element = page.locator('iframe[title="Guizang Design"], iframe[title="歸藏设计"]')
  await element.waitFor()
  const url = new URL((await element.getAttribute('src'))!, origin)
  return { url, frame: element.contentFrame() }
}

async function registerWork(page: Page, root: string, username: string) {
  const workspace = await defaultWorkspacePath(root, username)
  const title = `Guizang work by ${username}`
  expect(username).toMatch(/^[a-z-]+$/u)
  await writeFile(join(workspace, 'guizang-work.html'), `<!doctype html><title>${title}</title><h1>${title}</h1>`)
  await runCommunityTerminal(
    page,
    'node "$HOME/.dsh/profiles/web/node_modules/dsh-guizang-design/scripts/library.mjs" add ' +
      `"${instanceWorkspacePath(workspace, true)}/guizang-work.html" --skill guizang-page-skill --title "${title}" && printf 'GU_040_%s' DONE`,
    'GU_040_DONE',
  )
  return title
}

async function openWork(page: Page, origin: string, spaceId: string, title: string) {
  const { url, frame } = await gallery(page, origin)
  expect(url.pathname).toBe(`/app/${spaceId}/guizang-design/`)
  await frame.getByRole('link', { name: /^(My works|我的作品)$/iu }).click()
  const row = frame.getByRole('article').filter({ hasText: title })
  const link = row.locator('a[data-open]')
  const work = new URL((await link.getAttribute('href'))!, url)
  expect(work.pathname.startsWith(url.pathname + 'works/')).toBe(true)
  await link.click()
  await frame.locator('.viewer-body iframe').contentFrame().getByRole('heading', { name: title, exact: true }).waitFor()
  return { url, work, row }
}

it('installs the signed catalog Guizang through App Center on a member with no preinstall and retries a failed delivery', async () => {
  const delivered: Array<{ user: string; requestId: string }> = []
  const { api, origin, member, restart, root } = await fixture({
    pluginManager: native => ({
      list: native.list.bind(native),
      remove: native.remove.bind(native),
      ...(native.verifyArchive ? { verifyArchive: native.verifyArchive.bind(native) } : {}),
      async install(instance, target, archive, options, signal) {
        expect(options.identity).toEqual({ packageName, version: catalogVersion })
        expect(archive.integrity).toBe(catalogIntegrity)
        const first = !delivered.some(row => row.user === instance.userId)
        delivered.push({ user: instance.userId, requestId: options.requestId })
        if (instance.userId === 'guizang-retry' && first) throw Error('Simulated one-time member install failure')
        return native.install(instance, target, archive, options, signal)
      },
    }),
  })
  const catalog = () => api<CommunitySuiteCatalogView>('suites')
  const catalogView = await catalog()
  expect(catalogView.source.status).toBe('ok')
  const entry = catalogView.entries.find(item => item.id === packageName)
  expect(entry).toMatchObject({ available: true, plugin: { packageName, version: catalogVersion, integrity: catalogIntegrity } })
  await api('suites', { action: 'install', input: { id: packageName, requestId: 'guizang-040-import', publish: false } })
  const installation = async () => (await catalog()).installations.find(row => row.id === packageName)
  await expect.poll(async () => (await installation())?.status, { timeout: 720_000 }).toMatch(/^(installed|failed)$/u)
  expect((await installation())?.status, (await installation())?.failureCode ?? 'Guizang catalog install').toBe('installed')
  await api('plugins/publication', { action: 'publish', packageName, published: true, confirmed: true })
  const library = await api<CommunityPluginView[]>('plugins')
  expect(library.find(row => row.packageName === packageName)?.published).toBe(true)
  const select = async (username: string, retry: boolean) => {
    const { page, account } = await member(username)
    const group = await api<CommunityManagedGroupView>(`groups/${encodeURIComponent(account.groupId)}/plugins`)
    expect(group.plugins.some(row => row.packageName === packageName && row.preinstalled)).toBe(false)
    expect((await bundle(page, origin))?.installed ?? false).toBe(false)
    const market = async () => {
      const response = await page.request.get(origin + '/market/api/plugins')
      expect(response.ok()).toBe(true)
      return ((await response.json()) as CommunityMarketPageData).plugins.find(row => row.packageName === packageName)
    }
    await openCommunitySidebar(page)
    await appCenterButton(page).click()
    const panel = appCenterPanel(page)
    await panel.getByRole('tab', { name: 'Plugins', exact: true }).click()
    const listing = panel.locator('.phalanx-market-row').filter({ hasText: /Guizang|歸藏|dsh-guizang-design/u })
    const install = async (label: 'Install' | 'Retry installation', expected: 'succeeded' | 'failed') => {
      const accepted = page.waitForResponse(response => response.url().endsWith('/market/api/plugins') && response.request().method() === 'POST')
      await listing.getByRole('button', { name: label, exact: true }).click()
      expect((await accepted).status()).toBe(202)
      await expect.poll(async () => (await market())?.job?.status, { timeout: 720_000 }).toMatch(/^(succeeded|failed)$/u)
      const job = (await market())?.job
      expect(job?.status, `App Center ${label}: ${job?.failure?.code ?? job?.phase ?? 'missing job'}`).toBe(expected)
    }
    await install('Install', retry ? 'failed' : 'succeeded')
    if (retry) {
      expect((await bundle(page, origin))?.installed ?? false).toBe(false)
      await install('Retry installation', 'succeeded')
      expect(new Set(delivered.filter(row => row.user === username).map(row => row.requestId)).size).toBe(2)
    }
    await restart(page, username)
    expect((await market())?.installedVersion).toBe(catalogVersion)
    expect(await bundle(page, origin)).toMatchObject({ installed: true, version: catalogVersion })
    return { page, account }
  }
  const first = await select('guizang-selected', false)
  const retried = await select('guizang-retry', true)
  for (const [owner, other, username] of [
    [first, retried, 'guizang-selected'],
    [retried, first, 'guizang-retry'],
  ] as const) {
    const title = await registerWork(owner.page, root, username)
    const { work } = await openWork(owner.page, origin, owner.account.spaceId, title)
    expect((await owner.page.request.get(work.href)).status()).toBe(200)
    expect((await other.page.request.get(work.href)).status()).toBe(403)
  }
  console.info('Guizang signed App Center install, retry and isolated workspace readback passed')
}, 1_800_000)

it('confirms the original native Guizang route and opens a compatible archive through native DSH', async () => {
  const { origin, member, restart, root } = await fixture()
  const original = await member('guizang-original')
  await nativeInstall(original.page, packageName + '@0.1.4')
  await restart(original.page, original.username)
  expect(await bundle(original.page, origin)).toMatchObject({ installed: true, version: '0.1.4', source: expect.stringContaining(packageName) })
  const originalProfile = dshWebProfilePath(await memberHomePath(root, original.username))
  expect(await readFile(join(originalProfile, DSH_PROFILE_LOCK), 'utf8')).toContain(resolvedNpmIntegrity)
  const { url: originalUrl } = await gallery(original.page, origin)
  expect(originalUrl.pathname).toBe('/guizang-design/')
  expect((await original.page.request.get(originalUrl.href)).status()).toBe(403)
  console.info('Guizang npm 0.1.4 resolves to the site-root sidebar and returns HTTP 403')

  const compatible = await member('guizang-native')
  const home = await memberHomePath(root, compatible.username)
  const download = await fetch(nativeArchive, { signal: AbortSignal.timeout(90_000) })
  expect(download.ok, `Download the published Guizang archive, HTTP ${download.status}`).toBe(true)
  const bytes = Buffer.from(await download.arrayBuffer())
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(nativeArchiveDigest)
  const downloaded = join(root, nativeArchiveFilename)
  await writeFile(downloaded, bytes)
  await startCommunitySession(compatible.page)
  const editor = compatible.page.locator('[data-conversation-content]:visible')
  await editor.locator('input[type="file"]').setInputFiles(downloaded)
  const attachmentParts = ['attachments', 'v1', 'files', nativeArchiveDigest.slice(0, 2), nativeArchiveDigest, nativeArchiveFilename]
  const stored = join(dshHomePath(home), ...attachmentParts)
  await expect
    .poll(
      () =>
        readFile(stored).then(
          file => createHash('sha256').update(file).digest('hex'),
          () => '',
        ),
      {
        timeout: 90_000,
        message: 'Browser attachment upload should publish the verified archive in the member home',
      },
    )
    .toBe(nativeArchiveDigest)
  await editor.getByTitle(nativeArchiveFilename).waitFor()
  const path = join(CONTAINER_HOME, '.dsh', ...attachmentParts)
  await nativeInstall(compatible.page, path)
  await restart(compatible.page, compatible.username)
  expect(await bundle(compatible.page, origin)).toMatchObject({ installed: true, version: nativeVersion, source: expect.stringMatching(/^file:/u) })
  expect(await readFile(join(dshWebProfilePath(home), DSH_PROFILE_LOCK), 'utf8')).toContain(`sha512-${createHash('sha512').update(bytes).digest('base64')}`)
  const title = await registerWork(compatible.page, root, compatible.username)
  const data = join(dshHomePath(home), 'guizang-design')
  const library = JSON.parse(await readFile(join(data, 'library.json'), 'utf8')) as { works: Array<{ id: string; title: string }> }
  const workId = library.works.find(row => row.title === title)?.id
  expect(workId).toMatch(/^[a-f0-9]{8}$/u)
  const thumbnail = await compatible.page.context().newPage()
  await thumbnail.setContent(`<h1>${title}</h1>`)
  await mkdir(join(data, 'thumbs'), { recursive: true })
  await thumbnail.screenshot({ type: 'jpeg', path: join(data, 'thumbs', workId + '.jpg') })
  await thumbnail.close()
  const { url, work, row } = await openWork(compatible.page, origin, compatible.account.spaceId, title)
  const image = new URL((await row.locator('img').getAttribute('src'))!, url)
  expect(image.pathname.startsWith(url.pathname + 'thumbs/')).toBe(true)
  const direct = await compatible.page.context().newPage()
  for (const target of [url, work, image]) {
    expect((await direct.goto(target.href))?.status()).toBe(200)
    expect((await direct.reload())?.status()).toBe(200)
    expect((await original.page.request.get(target.href)).status()).toBe(403)
  }
  await direct.close()
  console.info('Guizang compatible native archive, gallery, work and thumbnail reload passed')
}, 1_200_000)
