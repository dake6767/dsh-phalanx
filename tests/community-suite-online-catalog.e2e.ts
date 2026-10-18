// Validation: T1; real credentials: none; controlled browser/process fixtures. CI selects its explicit public-entry subset.
import { execFile, spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium, type Browser, type Page } from 'playwright'
import { expect, it, vi } from 'vitest'
import { createCommunityApplication } from '../src/composition/community-application.js'
import type { CommunityApplication } from '../src/ports/community-application.js'
import { FileExecutionArtifacts } from '../src/adapters/execution-artifacts.js'
import { readBootstrapCredential } from '../src/adapters/bootstrap-credential.js'
import { withSuiteCatalogContentHash, type SuiteCatalogDocumentEntry } from '../src/domain/suite-catalog-document.js'
import { createCatalogSigningKey } from './fixtures/suite-catalog-signing.js'
import { onlineCatalogEntries } from './fixtures/suite-catalog-online.js'
import { buildBaseFieldArtifacts, documentSuiteCatalogFixture, rawSuiteCatalogFixture, signedBytes, throwawaySigningKey, type SuiteCatalogServerFixture } from './fixtures/suite-catalog-server.js'
import { gitFixture } from './fixtures/skills/git-repository.js'
import { validSkill } from './fixtures/skills/archive.js'

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

async function loadCatalog(page: Page, origin: string): Promise<void> {
  const response = await page.request.get(origin + '/admin/api/suites')
  expect(response.status()).toBe(200)
}

async function openCatalog(page: Page, origin: string): Promise<void> {
  await page.getByRole('link', { name: 'Suite catalog', exact: true }).click()
  await page.waitForURL(`${origin}/admin/suites`)
  await page.getByRole('heading', { name: 'Suite catalog', exact: true }).waitFor()
}

interface OfflineCatalog {
  readonly catalog: SuiteCatalogServerFixture
  /** Local smart-Git service that answers for github.com, so skill imports stay offline. */
  readonly git?: Awaited<ReturnType<typeof gitFixture>>
  close(): Promise<void>
}

/**
 * The base-field entries with locally served artifacts and a local Git service that answers for github.com.
 * Controlled fixtures only: nothing here reaches GitHub or npm.
 */
async function baseFieldFixture(entries: readonly SuiteCatalogDocumentEntry[] = onlineCatalogEntries): Promise<OfflineCatalog> {
  const skillNames = [...new Set(entries.flatMap(entry => entry.kind === 'suite' || entry.kind === 'dependency'
    ? entry.items.flatMap(item => item.kind === 'skill' ? item.names : []) : []))]
  let git: Awaited<ReturnType<typeof gitFixture>> | undefined
  let served = entries
  if (skillNames.length) {
    git = await gitFixture({ host: 'github.com', repository: 'dsh-phalanx-fixtures/skills.git' })
    const commit = await git.commit(Object.fromEntries(skillNames.map(name => [`skills/${name}/SKILL.md`, validSkill.replace('example-skill', name).replace('A useful skill', `${name} skill`)])))
    served = entries.map(entry => {
      if (entry.kind !== 'suite' && entry.kind !== 'dependency') return entry
      return { ...entry, items: entry.items.map(item => item.kind === 'skill'
        ? { ...item, source: { type: 'git' as const, url: git!.url, commit, path: 'skills' } }
        : item) }
    })
  }
  // Chromium is a zip upstream; the fixture serves the same layout as a tar so CI needs no zip binary.
  const catalog = await documentSuiteCatalogFixture(served, await buildBaseFieldArtifacts(), { syntheticExtract: true })
  return { catalog, ...(git ? { git } : {}), close: async () => { await catalog.close(); await git?.close() } }
}

const run = promisify(execFile)

/** Directory where a generated entry command lives, so tests resolve it through PATH like a member would. */
async function installedDirectory(root: string, name: string): Promise<string> {
  const trees = join(root, 'runtime-dependencies', '.trees')
  const { stdout } = await run('find', [trees, '-name', name])
  const path = stdout.split('\n').find(Boolean)
  if (!path) throw new Error(`The prepared ${name} command is missing`)
  return path.slice(0, path.lastIndexOf('/'))
}

/** Resolves and runs one generated entry command through PATH, proving the wrapper/symlink entry itself works. */
async function runInstalled(root: string, name: string, args: readonly string[] = ['--version'], environment: Readonly<Record<string, string>> = {}): Promise<string> {
  const directory = await installedDirectory(root, name)
  const result = await run(name, [...args], { env: { ...process.env, ...environment, PATH: `${directory}:${process.env.PATH ?? ''}` } })
  return result.stdout
}

const pathEnvironment = (directory: string, environment: Readonly<Record<string, string>> = {}) => ({ ...process.env, ...environment, PATH: `${directory}:${process.env.PATH ?? ''}` })

it('installs Pandoc, FFmpeg, Chromium and WeCom from the signed declarative catalog and uninstalls them', async () => {
  const fixture = await baseFieldFixture(onlineCatalogEntries)
  if (fixture.git) { vi.stubEnv('HTTPS_PROXY', fixture.git.proxy); vi.stubEnv('GIT_SSL_CAINFO', fixture.git.caFile) }
  const running = await launch(fixture.catalog)
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
    await install('pandoc'); await install('ffmpeg'); await install('chromium'); await install('wecom')
    const dependencies = (await (await running.page.request.get(running.origin + '/admin/api/runtime-dependencies')).json()) as
      { name: string, source: string, checks: { kind: string, passed: boolean }[], current?: { commands: string[] } }[]
    expect(dependencies.find(row => row.name === 'pandoc')).toMatchObject({ source: 'suite-catalog', current: { commands: ['pandoc'] } })
    expect(dependencies.find(row => row.name === 'ffmpeg')).toMatchObject({ current: { commands: ['ffmpeg', 'ffprobe'] } })
    expect(dependencies.find(row => row.name === 'chromium')).toMatchObject({ current: { commands: ['chromium-headless-shell'] } })
    // WeCom exercises the registry install: pinned packages from the fixture registry, then the readiness check.
    expect(dependencies.find(row => row.name === 'wecom-tools')).toMatchObject({ current: { commands: ['wecom-cli'] } })
    for (const name of ['pandoc', 'wecom-tools']) expect(dependencies.find(row => row.name === name)?.checks).toEqual(expect.arrayContaining([{ kind: 'check-command', passed: true }]))
    // The installed entry commands can actually be executed, not just prepared.
    expect(await runInstalled(running.root, 'pandoc')).toContain('pandoc fixture')
    expect(await runInstalled(running.root, 'wecom-cli')).toContain('wecom-cli fixture')
    expect(await runInstalled(running.root, 'chromium-headless-shell')).toContain('chromium fixture')
    // Controlled browser uninstall of the declarative dependency.
    await running.page.reload()
    await card(running.page, 'pandoc').getByText('Installed', { exact: true }).waitFor()
    await card(running.page, 'pandoc').getByRole('button', { name: 'Uninstall', exact: true }).click()
    const dialog = running.page.getByRole('dialog', { name: 'pandoc' })
    await dialog.getByText('This will remove:', { exact: true }).waitFor()
    await dialog.getByRole('button', { name: 'Confirm uninstall', exact: true }).click()
    await card(running.page, 'pandoc').getByText('Not installed', { exact: true }).waitFor({ timeout: 60000 })
    expect(((await (await running.page.request.get(running.origin + '/admin/api/runtime-dependencies')).json()) as { name: string }[]).some(row => row.name === 'pandoc')).toBe(false)
    // The remaining entries are removed through the same management API, so the title is honest for all four.
    for (const id of ['wecom', 'ffmpeg', 'chromium']) {
      expect((await running.page.request.post(running.origin + '/admin/api/suites', { headers: { origin: running.origin }, data: { action: 'uninstall', id, input: {} } })).status()).toBe(202)
      await expect.poll(async () => ((await (await running.page.request.get(running.origin + '/admin/api/suites')).json()) as { installations: { id: string }[] }).installations.some(row => row.id === id), { timeout: 60000 }).toBe(false)
    }
    const remaining = (await (await running.page.request.get(running.origin + '/admin/api/runtime-dependencies')).json()) as { name: string }[]
    for (const name of ['pandoc', 'ffmpeg', 'chromium', 'wecom-tools']) expect(remaining.some(row => row.name === name), name).toBe(false)
  } finally { vi.unstubAllEnvs(); await fixture.close(); await stop(running) }
})

it('installs OfficeCLI and MiniMax through generated adapters and enforces their wrappers', async () => {
  const fixture = await baseFieldFixture()
  if (fixture.git) { vi.stubEnv('HTTPS_PROXY', fixture.git.proxy); vi.stubEnv('GIT_SSL_CAINFO', fixture.git.caFile) }
  const running = await launch(fixture.catalog)
  try {
    await openCatalog(running.page, running.origin)
    for (const name of ['OfficeCLI', 'MiniMax']) {
      await card(running.page, name).getByText('Not installed', { exact: true }).waitFor()
      expect(await card(running.page, name).getByRole('button', { name: 'Install', exact: true }).count()).toBe(1)
    }
    const install = async (id: string) => {
      expect((await running.page.request.post(running.origin + '/admin/api/suites', { headers: { origin: running.origin }, data: { action: 'install', input: { id, requestId: `request-adapter-${id}-001` } } })).status()).toBe(202)
      await expect.poll(async () => ((await (await running.page.request.get(running.origin + '/admin/api/suites')).json()) as { installations: { id: string, status: string }[] }).installations.find(row => row.id === id)?.status, { timeout: 120000 }).toBe('installed')
    }
    await install('officecli'); await install('minimax')
    const dependencies = (await (await running.page.request.get(running.origin + '/admin/api/runtime-dependencies')).json()) as { name: string, checks: { kind: string, passed: boolean }[] }[]
    for (const name of ['office-tools', 'minimax-tools']) expect(dependencies.find(row => row.name === name)?.checks).toEqual(expect.arrayContaining([{ kind: 'check-command', passed: true }]))

    // OfficeCLI: the fixed environment reaches the real binary through the generated wrapper.
    expect((await runInstalled(running.root, 'officecli')).trim()).toBe('skip=1')

    // MiniMax: credential appended as argv, region fixed, documented agent flags (including --yes) passed through unchanged.
    const minimaxEnvironment = { MINIMAX_API_KEY: 'team-key', MINIMAX_REGION: 'global' }
    const allowed = JSON.parse(await runInstalled(running.root, 'mmx', ['image', 'generate', '--prompt', 'circle', '--quiet', '--yes'], minimaxEnvironment)) as { argv: string[], region: string }
    // The member keeps using --yes; the generated wrapper hands the upstream CLI --non-interactive instead.
    expect(allowed.argv).toEqual(['image', 'generate', '--prompt', 'circle', '--quiet', '--non-interactive', '--api-key', 'team-key'])
    expect(allowed.argv).not.toContain('--yes')
    expect(allowed.region).toBe('cn')
    const minimaxDir = await installedDirectory(running.root, 'mmx')
    const refused = spawnSync('mmx', ['text', 'chat', '--region=global'], { encoding: 'utf8', env: pathEnvironment(minimaxDir, minimaxEnvironment) })
    expect(refused.status).toBe(2); expect(refused.stdout).toBe(''); expect(refused.stderr).toContain('This option is disabled by the platform.')
    // The credential only travels through the environment: neither the wrapper nor any generated file contains it.
    const wrapper = await readFile(join(minimaxDir, 'mmx'), 'utf8')
    expect(wrapper).not.toContain('team-key'); expect(wrapper).toContain('MINIMAX_API_KEY')

    for (const id of ['officecli', 'minimax']) {
      expect((await running.page.request.post(running.origin + '/admin/api/suites', { headers: { origin: running.origin }, data: { action: 'uninstall', id, input: {} } })).status()).toBe(202)
      await expect.poll(async () => ((await (await running.page.request.get(running.origin + '/admin/api/suites')).json()) as { installations: { id: string }[] }).installations.some(row => row.id === id), { timeout: 60000 }).toBe(false)
    }
  } finally { vi.unstubAllEnvs(); await fixture.close(); await stop(running) }
})

it('marks a signed entry that fails the platform download checks as unavailable', async () => {
  const artifacts = new Map<string, Buffer>([['https://example.com/tool-amd64.bin', Buffer.from('#!/bin/sh\n')], ['https://example.com/tool-arm64.bin', Buffer.from('#!/bin/sh\n')]])
  const entry = withSuiteCatalogContentHash({ kind: 'dependency', id: 'unsafe-source', version: '1.0.0', engines: { platform: '>=0.1.18' }, adapters: [],
    title: { en: 'Unsafe source', 'zh-CN': '不安全来源' }, description: { en: 'Unsafe source', 'zh-CN': '不安全来源' }, source: { en: 'fixture', 'zh-CN': '夹具' },
    items: [{ kind: 'runtime-dependency', name: 'tool', paths: ['bin'], commands: ['tool'], check: { command: 'tool' },
      downloads: [{ source: 'github-assets', url: 'https://example.com/tool-{arch}.bin', sha256: { amd64: 'a'.repeat(64), arm64: 'b'.repeat(64) }, target: 'bin/tool', executable: true }] }] } as never)
  const catalog = await documentSuiteCatalogFixture([entry], artifacts)
  const running = await launch(catalog)
  try {
    await openCatalog(running.page, running.origin)
    const blocked = card(running.page, 'Unsafe source')
    await blocked.getByText('The catalog entry failed the platform download checks.', { exact: true }).waitFor()
    await blocked.getByText('outside the five download-source classes').waitFor()
    expect(await blocked.getByRole('button', { name: 'Install', exact: true }).isDisabled()).toBe(true)
    const view = (await (await running.page.request.get(running.origin + '/admin/api/suites')).json()) as { entries: { id: string, available: boolean, unavailableReason?: string }[] }
    expect(view.entries.find(row => row.id === 'unsafe-source')).toMatchObject({ available: false, unavailableReason: 'invalid-entry' })
  } finally { await catalog.close(); await stop(running) }
})

it('shows the unreachable state with address and reason, and still uninstalls an installed entry', async () => {
  const fixture = await baseFieldFixture(onlineCatalogEntries.filter(entry => entry.id === 'pandoc'))
  if (fixture.git) { vi.stubEnv('HTTPS_PROXY', fixture.git.proxy); vi.stubEnv('GIT_SSL_CAINFO', fixture.git.caFile) }
  const catalog = fixture.catalog
  const running = await launch(catalog)
  try {
    // Opening the gallery loads the catalog; the install action itself never waits for the service.
    await loadCatalog(running.page, running.origin)
    const install = await running.page.request.post(running.origin + '/admin/api/suites', { headers: { origin: running.origin }, data: { action: 'install', input: { id: 'pandoc', requestId: 'request-unreachable-0001' } } })
    expect(install.status()).toBe(202)
    await expect.poll(async () => ((await (await running.page.request.get(running.origin + '/admin/api/suites')).json()) as { installations: { status: string }[] }).installations[0]?.status, { timeout: 120000 }).toBe('installed')
    catalog.fail(true)
    await openCatalog(running.page, running.origin)
    await running.page.getByText('The catalog service is unreachable', { exact: true }).waitFor()
    await running.page.getByText(catalog.address).waitFor()
    await running.page.getByText('Installed entries outside the catalog', { exact: true }).waitFor()
    // Uninstalling reads local records only: the preview and the action must not ask the failing catalog again.
    const requestsBeforeRemoval = catalog.requests()
    expect((await running.page.request.get(running.origin + '/admin/api/suites/uninstall-preview?id=pandoc')).status()).toBe(200)
    expect(catalog.requests()).toBe(requestsBeforeRemoval)
    expect((await running.page.request.post(running.origin + '/admin/api/suites', { headers: { origin: running.origin }, data: { action: 'uninstall', id: 'pandoc', input: {} } })).status()).toBe(202)
    expect(catalog.requests()).toBe(requestsBeforeRemoval)
    await running.page.reload()
    await running.page.getByText('Installed entries outside the catalog', { exact: true }).waitFor({ state: 'detached', timeout: 60000 })
  } finally { vi.unstubAllEnvs(); await fixture.close(); await stop(running) }
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
  const fixture = await baseFieldFixture([pandoc, newer])
  const running = await launch(fixture.catalog)
  try {
    await openCatalog(running.page, running.origin)
    await card(running.page, 'pandoc').filter({ hasNotText: 'Needs a newer platform version' }).getByRole('button', { name: 'Install', exact: true }).waitFor()
    // The newer entry shares the title but differs by id; both cards are visible and only the incompatible one is refused.
    const blocked = running.page.locator('.plugin-library-card').filter({ hasText: 'Needs a newer platform version' })
    await blocked.waitFor()
    expect(await blocked.getByRole('button', { name: 'Install', exact: true }).isDisabled()).toBe(true)
  } finally { await fixture.close(); await stop(running) }
})

it('refuses changed content for the same installed id and version', async () => {
  const pandoc = onlineCatalogEntries.find(entry => entry.id === 'pandoc')!
  if (pandoc.kind !== 'dependency') throw new Error('unexpected kind')
  const fixture = await baseFieldFixture([pandoc])
  const catalog = fixture.catalog
  const running = await launch(catalog)
  try {
    await loadCatalog(running.page, running.origin)
    await running.page.request.post(running.origin + '/admin/api/suites', { headers: { origin: running.origin }, data: { action: 'install', input: { id: 'pandoc', requestId: 'request-immutable-0001' } } })
    await expect.poll(async () => ((await (await running.page.request.get(running.origin + '/admin/api/suites')).json()) as { installations: { status: string }[] }).installations[0]?.status, { timeout: 120000 }).toBe('installed')
    catalog.publish([withSuiteCatalogContentHash({ ...pandoc, description: { ...pandoc.description, en: 'Changed content for the same published version' } })])
    await openCatalog(running.page, running.origin)
    await running.page.getByText('The catalog content for this version changed after it was installed.', { exact: true }).waitFor()
    const view = (await (await running.page.request.get(running.origin + '/admin/api/suites')).json()) as { entries: { id: string, available: boolean, unavailableReason?: string }[] }
    expect(view.entries.find(entry => entry.id === 'pandoc')).toMatchObject({ available: false, unavailableReason: 'content-tampered' })
    const response = await running.page.request.post(running.origin + '/admin/api/suites', { headers: { origin: running.origin }, data: { action: 'update', id: 'pandoc' } })
    expect(response.status()).toBeGreaterThanOrEqual(400)
  } finally { await fixture.close(); await stop(running) }
})
