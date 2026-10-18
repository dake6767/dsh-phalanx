// Validation: T1; real credentials: none; controlled browser/process fixtures. CI selects its explicit public-entry subset.
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium, type Browser, type Page } from 'playwright'
import { expect, it } from 'vitest'
import { createCommunityApplication } from '../src/composition/community-application.js'
import type { CommunityApplication } from '../src/ports/community-application.js'
import { FileExecutionArtifacts } from '../src/adapters/execution-artifacts.js'
import { readBootstrapCredential } from '../src/adapters/bootstrap-credential.js'
import { withSuiteCatalogContentHash, type SuiteCatalogDocumentEntry } from '../src/domain/suite-catalog-document.js'
import { createCatalogSigningKey, signCatalog } from './fixtures/suite-catalog-signing.js'
import { onlineCatalogEntries } from './fixtures/suite-catalog-online.js'
import { buildBaseFieldArtifacts, documentSuiteCatalogFixture, rawSuiteCatalogFixture, signedBytes, throwawaySigningKey, type SuiteCatalogServerFixture } from './fixtures/suite-catalog-server.js'

interface Running {
  readonly app: CommunityApplication
  readonly root: string
  readonly origin: string
  readonly browser: Browser
  readonly page: Page
}

async function launch(catalog: SuiteCatalogServerFixture): Promise<Running> {
  const root = await mkdtemp(join(tmpdir(), 'suite-online-'))
  const app = createCommunityApplication({ downloadSources: catalog.downloadSources, listen: { host: '127.0.0.1', port: 0 },
    sessionSecret: 'suite-online-fixture-secret-000032', runtime: { command: '/unavailable', args: [], dataRoot: root, defaultModel: { provider: 'deepseek-official', model: 'fixture', upstream: { baseUrl: 'https://example.test' } } } },
  { suiteCatalog: { address: catalog.address, trustedKeys: catalog.trustedKeys } })
  const browser = await chromium.launch({ headless: true })
  try {
    const origin = await app.start()
    const page = await browser.newPage({ locale: 'en', viewport: { width: 1440, height: 1000 } }); page.setDefaultTimeout(30000)
    await page.goto(`${origin}/bootstrap#credential=${readBootstrapCredential(root)!.credential}`)
    await page.getByLabel('Username', { exact: true }).fill('admin'); await page.getByLabel('Password', { exact: true }).fill('password')
    await page.getByRole('button', { name: 'Create administrator' }).click(); await page.waitForURL(`${origin}/admin`)
    return { app, root, origin, browser, page }
  } catch (error) {
    await browser.close().catch(() => {}); await app.stop().catch(() => {})
    await rm(root, { recursive: true, force: true })
    throw error
  }
}

async function stop(running: Running): Promise<void> {
  await running.browser.close(); await running.app.stop()
  await new FileExecutionArtifacts(join(running.root, 'runtime-dependencies', '.trees')).collect([])
  await rm(running.root, { recursive: true, force: true })
}

/** Cards are located by their accessible details button, so dependency lists cannot match the wrong card. */
function card(page: Page, title: string) {
  return page.locator('.plugin-library-card').filter({ has: page.getByRole('button', { name: `View suite entry ${title}`, exact: true }) })
}

async function openCatalog(page: Page, origin: string): Promise<void> {
  await page.getByRole('link', { name: 'Suite catalog', exact: true }).click()
  await page.waitForURL(`${origin}/admin/suites`)
  await page.getByRole('heading', { name: 'Suite catalog', exact: true }).waitFor()
}

/** The four base-field entries with locally served artifacts, so the platform exercises its real generation path. */
async function baseFieldFixture(entries: readonly SuiteCatalogDocumentEntry[] = onlineCatalogEntries): Promise<SuiteCatalogServerFixture> {
  return documentSuiteCatalogFixture(entries, await buildBaseFieldArtifacts())
}

it('installs Pandoc, FFmpeg and Chromium from the signed declarative catalog and uninstalls them', async () => {
  const catalog = await baseFieldFixture(onlineCatalogEntries)
  const running = await launch(catalog)
  try {
    await openCatalog(running.page, running.origin)
    for (const name of ['pandoc', 'FFmpeg', 'Chromium headless shell', 'WeCom']) {
      await card(running.page, name).getByText('Not installed', { exact: true }).waitFor()
      expect(await card(running.page, name).getByRole('button', { name: 'Install', exact: true }).count()).toBe(1)
    }
    const install = async (id: string) => {
      const response = await running.page.request.post(running.origin + '/admin/api/suites', { headers: { origin: running.origin }, data: { action: 'install', input: { id, requestId: `request-${id}-00000001` } } })
      expect(response.status()).toBe(202)
      await expect.poll(async () => ((await (await running.page.request.get(running.origin + '/admin/api/suites')).json()) as { installations: { id: string, status: string }[] }).installations.find(row => row.id === id)?.status, { timeout: 120000 }).toBe('installed')
    }
    await install('pandoc'); await install('ffmpeg'); await install('chromium')
    const dependencies = (await (await running.page.request.get(running.origin + '/admin/api/runtime-dependencies')).json()) as { name: string, source: string, current?: { commands: string[] } }[]
    expect(dependencies.find(row => row.name === 'pandoc')).toMatchObject({ source: 'suite-catalog', current: { commands: ['pandoc'] } })
    expect(dependencies.find(row => row.name === 'ffmpeg')).toMatchObject({ current: { commands: ['ffmpeg', 'ffprobe'] } })
    expect(dependencies.find(row => row.name === 'chromium')).toMatchObject({ current: { commands: ['chromium-headless-shell'] } })
    // Controlled browser uninstall of the declarative dependency.
    await running.page.reload()
    await card(running.page, 'pandoc').getByText('Installed', { exact: true }).waitFor()
    await card(running.page, 'pandoc').getByRole('button', { name: 'Uninstall', exact: true }).click()
    const dialog = running.page.getByRole('dialog', { name: 'pandoc' })
    await dialog.getByText('This will remove:', { exact: true }).waitFor()
    await dialog.getByRole('button', { name: 'Confirm uninstall', exact: true }).click()
    await card(running.page, 'pandoc').getByText('Not installed', { exact: true }).waitFor({ timeout: 60000 })
    expect(((await (await running.page.request.get(running.origin + '/admin/api/runtime-dependencies')).json()) as { name: string }[]).some(row => row.name === 'pandoc')).toBe(false)
  } finally { await catalog.close(); await stop(running) }
})

it('shows the unreachable state with address and reason, and still uninstalls an installed entry', async () => {
  const catalog = await baseFieldFixture(onlineCatalogEntries.filter(entry => entry.id === 'pandoc'))
  const running = await launch(catalog)
  try {
    const install = await running.page.request.post(running.origin + '/admin/api/suites', { headers: { origin: running.origin }, data: { action: 'install', input: { id: 'pandoc', requestId: 'request-unreachable-0001' } } })
    expect(install.status()).toBe(202)
    await expect.poll(async () => ((await (await running.page.request.get(running.origin + '/admin/api/suites')).json()) as { installations: { status: string }[] }).installations[0]?.status, { timeout: 120000 }).toBe('installed')
    await catalog.close()
    await openCatalog(running.page, running.origin)
    await running.page.getByText('The catalog service is unreachable', { exact: true }).waitFor()
    await running.page.getByText(catalog.address).waitFor()
    await running.page.getByText('Installed entries outside the catalog', { exact: true }).waitFor()
    await running.page.getByRole('button', { name: 'Uninstall', exact: true }).click()
    const dialog = running.page.getByRole('dialog', { name: 'pandoc' })
    await dialog.getByRole('button', { name: 'Confirm uninstall', exact: true }).click()
    await running.page.getByText('Installed entries outside the catalog', { exact: true }).waitFor({ state: 'detached', timeout: 60000 })
  } finally { await stop(running) }
})

it('rejects the whole catalog when its signing key is not trusted', async () => {
  const bytes = await signedBytes(onlineCatalogEntries, throwawaySigningKey())
  const catalog = await rawSuiteCatalogFixture(bytes, [createCatalogSigningKey('trusted-other-key')])
  const running = await launch(catalog)
  try {
    await openCatalog(running.page, running.origin)
    await running.page.getByText('The catalog was rejected', { exact: true }).waitFor()
    await running.page.getByText('The catalog was signed with a key this platform does not trust.', { exact: true }).waitFor()
    expect(await running.page.locator('.plugin-library-card').filter({ hasText: 'pandoc' }).count()).toBe(0)
  } finally { await catalog.close(); await stop(running) }
})

it('marks an entry that needs a newer platform as unavailable and keeps the others installable', async () => {
  const pandoc = onlineCatalogEntries.find(entry => entry.id === 'pandoc')!
  if (pandoc.kind !== 'dependency') throw new Error('unexpected kind')
  const newer = withSuiteCatalogContentHash({ ...pandoc, id: 'pandoc-newer', engines: { platform: '>=999.0.0' } })
  const catalog = await baseFieldFixture([pandoc, newer])
  const running = await launch(catalog)
  try {
    await openCatalog(running.page, running.origin)
    await card(running.page, 'pandoc').filter({ hasNotText: 'Needs a newer platform version' }).getByRole('button', { name: 'Install', exact: true }).waitFor()
    // The newer entry shares the title but differs by id; both cards are visible and only the incompatible one is refused.
    const blocked = running.page.locator('.plugin-library-card').filter({ hasText: 'Needs a newer platform version' })
    await blocked.waitFor()
    expect(await blocked.getByRole('button', { name: 'Install', exact: true }).isDisabled()).toBe(true)
  } finally { await catalog.close(); await stop(running) }
})

it('refuses changed content for the same installed id and version', async () => {
  const pandoc = onlineCatalogEntries.find(entry => entry.id === 'pandoc')!
  if (pandoc.kind !== 'dependency') throw new Error('unexpected kind')
  const catalog = await baseFieldFixture([pandoc])
  const running = await launch(catalog)
  try {
    await running.page.request.post(running.origin + '/admin/api/suites', { headers: { origin: running.origin }, data: { action: 'install', input: { id: 'pandoc', requestId: 'request-immutable-0001' } } })
    await expect.poll(async () => ((await (await running.page.request.get(running.origin + '/admin/api/suites')).json()) as { installations: { status: string }[] }).installations[0]?.status, { timeout: 120000 }).toBe('installed')
    catalog.publish([withSuiteCatalogContentHash({ ...pandoc, description: { ...pandoc.description, en: 'Changed content for the same published version' } })])
    await openCatalog(running.page, running.origin)
    await running.page.getByText('The catalog content for this version changed after it was installed.', { exact: true }).waitFor()
    const view = (await (await running.page.request.get(running.origin + '/admin/api/suites')).json()) as { entries: { id: string, available: boolean, unavailableReason?: string }[] }
    expect(view.entries.find(entry => entry.id === 'pandoc')).toMatchObject({ available: false, unavailableReason: 'content-tampered' })
    const response = await running.page.request.post(running.origin + '/admin/api/suites', { headers: { origin: running.origin }, data: { action: 'update', id: 'pandoc' } })
    expect(response.status()).toBeGreaterThanOrEqual(400)
  } finally { await catalog.close(); await stop(running) }
})
