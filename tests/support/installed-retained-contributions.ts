import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { APIResponse, Page } from 'playwright'
import { expect } from 'vitest'
import { packExpertPlugin, expertFixturePackage } from '../fixtures/expert-plugin.js'
import { officialSuiteCatalogKeys } from '../../src/domain/suite-catalog-keys.js'
import { readSuiteCatalog } from '../../src/domain/suite-catalog-reader.js'
import type { CommunitySuiteCatalogView, CommunityPluginView, CommunityPluginAccessView, CommunityManagedGroupView, CommunityMarketPageData } from '../../src/domain/admin-contract.js'
import type { SuiteInstallRecord } from '../../src/domain/suite-install.js'

export const retainedCatalogSha256 = '80b1e539a1225d5a6db38e2fcfa5d8d8d7a20d4be44dd43a667f8878704ed54f'
export const retainedFixtureIdentity = 'officecli-2.0.0-managed-expert-native-dependent-v1'
const catalogAddress = 'https://github.com/dake6767/dsh-phalanx-catalog/releases/download/catalog-40075953922/catalog.json'
const nativePackage = '@example/expert-dependent'
export const retainedPluginPackages = [expertFixturePackage, nativePackage].sort()
const packages = retainedPluginPackages
interface Api {
  get<T>(path: string): Promise<T>
  post(path: string, body: object, timeout?: number): Promise<APIResponse>
  origin: string; admin: Page; member: Page; groupId: string
}

/** Original release bytes, verified with the product's unchanged official trust keys. */
export async function retainedOfficialCatalog(platformVersion: string) {
  const response = await fetch(catalogAddress, { signal: AbortSignal.timeout(30000) })
  expect(response.status).toBe(200)
  const bytes = Buffer.from(await response.arrayBuffer())
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(retainedCatalogSha256)
  const catalog = readSuiteCatalog(bytes, { trustedKeys: officialSuiteCatalogKeys, platformVersion })
  if (catalog.status !== 'ok') throw Error('The retained catalog must have a valid official signature')
  const entry = catalog.entries.find(row => row.entry.id === 'officecli')
  expect(entry).toMatchObject({ entry: { version: '2.0.0' } })
  if (!entry || entry.unavailableReason) throw Error('The formal baseline must support the retained OfficeCLI entry')
  return { bytes, contentHash: entry.contentHash }
}

/** Seed through the formally installed product, with distinct managed/native packages. */
export async function seedRetainedCatalog(api: Api) {
  const installed = (await api.get<CommunitySuiteCatalogView>('suites')).installations.find(row => row.id === 'officecli')
  if (!installed) expect((await api.post('suites', { action: 'install', input: { id: 'officecli', requestId: 'retained-officecli-install', groups: [api.groupId], publish: true } })).status()).toBe(202)
  await expect.poll(async () => (await api.get<CommunitySuiteCatalogView>('suites')).installations.find(row => row.id === 'officecli')?.status,
    { timeout: 900000 }).toMatch(/^(installed|failed)$/u)
  expect((await api.get<CommunitySuiteCatalogView>('suites')).installations.find(row => row.id === 'officecli')).toMatchObject({ version: '2.0.0', status: 'installed' })
  await expect.poll(async () => (await api.get<{ stage: string }>('runtime-dependencies?name=office-tools')).stage, { timeout: 660000 }).toBe('ready')
}

export async function seedRetainedPluginLibrary(api: Api) {
  const temporary = await mkdtemp(join(tmpdir(), 'installed-retained-plugins-'))
  try {
    for (const kind of ['healthy', 'dependent'] as const) {
      const packed = await packExpertPlugin(temporary, kind)
      const existing = (await api.get<CommunityPluginView[]>('plugins')).find(row => row.packageName === packed.packageName)
      if (existing) { expect(existing.version).toBe('1.0.0'); continue }
      const uploaded = await api.admin.request.post(api.origin + '/admin/api/plugins/upload', { headers: { origin: api.origin,
        'content-type': 'application/gzip', 'x-plugin-filename': kind + '.tgz' }, data: await readFile(packed.archive) })
      expect(uploaded.status()).toBe(202)
    }
  } finally { await rm(temporary, { recursive: true, force: true }) }
}

export async function publishRetainedPlugins(api: Api) {
  for (const packageName of packages) {
    await expect.poll(async () => (await api.get<CommunityPluginView[]>('plugins')).find(row => row.packageName === packageName)?.stage,
      { timeout: 660000 }).toMatch(/^(available|failed)$/u)
    expect((await api.get<CommunityPluginView[]>('plugins')).find(row => row.packageName === packageName)).toMatchObject({ stage: 'available', version: '1.0.0' })
    expect((await api.post('plugins/publication', { action: 'publish', packageName, published: true, confirmed: true })).status()).toBe(200)
  }
  expect((await api.post('plugins/access?packageName=' + encodeURIComponent(expertFixturePackage), {
    environment: [], entriesYaml: JSON.stringify({ consumer: { label: 'retained-configuration', nested: { retained: true } } }),
  })).status()).toBe(200)
  const path = `groups/${api.groupId}/plugins`, grant = await api.get<CommunityManagedGroupView>(path)
  expect((await api.post(path, { action: 'save', packages: [expertFixturePackage], preinstalls: [], revision: grant.revision })).status()).toBe(200)
  const initial = (await (await api.member.request.get(api.origin + '/market/api/plugins')).json()) as CommunityMarketPageData
  if (initial.plugins.find(row => row.packageName === nativePackage)?.status !== 'installed') {
    const response = await api.member.request.post(api.origin + '/market/api/plugins', { headers: { origin: api.origin }, data: { action: 'install', packageName: nativePackage, requestId: randomUUID() } })
    expect(response.status()).toBe(202)
  }
  if (initial.plugins.find(row => row.packageName === nativePackage)?.status !== 'installed') await expect.poll(async () => ((await (await api.member.request.get(api.origin + '/market/api/plugins')).json()) as CommunityMarketPageData).plugins.find(row => row.packageName === nativePackage)?.job?.status,
    { timeout: 660000 }).toMatch(/^(succeeded|failed)$/u)
  const market = (await (await api.member.request.get(api.origin + '/market/api/plugins')).json()) as CommunityMarketPageData
  expect(market.plugins.find(row => row.packageName === nativePackage)?.status).toBe('installed')
  expect((await api.member.request.post(api.origin + '/recovery/restart', { headers: { origin: api.origin }, data: { confirmed: true } })).status()).toBe(200)
}

/** API additions and artifact regeneration do not change the retained identities. */
export async function retainedContributionSnapshot(api: Api, remote: (command: string) => Promise<string>, contentHash: string) {
  const catalog = await api.get<CommunitySuiteCatalogView>('suites')
  expect(catalog.installations.length).toBeGreaterThan(0)
  const storage = JSON.parse(await remote('sudo cat /var/lib/dsh-phalanx/data/suites/installations.json')) as { installs: SuiteInstallRecord[] }
  expect(storage.installs.find(row => row.id === 'officecli')).toMatchObject({ version: '2.0.0', status: 'installed', contentHash })
  const installations = catalog.installations.map(({ id, version, status, entries, dependencies, manualDependencies, replaced }) => ({ id, version, status, entries, dependencies, manualDependencies, replaced }))
  const stored = storage.installs.map(({ id, version, status, contentHash, entries, dependencies, manualDependencies, replaced }) => ({ id, version, status, contentHash, entries, dependencies, manualDependencies, replaced }))
  const library = await api.get<CommunityPluginView[]>('plugins')
  const plugins = packages.map(packageName => {
    const row = library.find(row => row.packageName === packageName)
    expect(row).toMatchObject({ version: '1.0.0', currentVersion: '1.0.0', stage: 'available', published: true })
    if (!row) throw Error('A retained plugin is missing')
    const { source, version, currentVersion, integrity, published } = row
    expect(integrity).toMatch(/^sha512-/u)
    return { packageName, source, version, currentVersion, integrity, published }
  })
  const access = await Promise.all(packages.map(async packageName => {
    const { environment, entriesYaml } = await api.get<CommunityPluginAccessView>('plugins/access?packageName=' + encodeURIComponent(packageName))
    return { packageName, environment, entriesYaml }
  }))
  const grant = await api.get<CommunityManagedGroupView>(`groups/${api.groupId}/plugins`)
  const grants = grant.plugins.filter(row => packages.includes(row.packageName)).map(({ packageName, version, granted, preinstalled, hasPlatformCredential }) => ({ packageName, version, granted, preinstalled, hasPlatformCredential }))
  expect(grants.find(row => row.packageName === expertFixturePackage)).toMatchObject({ granted: true, preinstalled: false })
  const market = (await (await api.member.request.get(api.origin + '/market/api/plugins')).json()) as CommunityMarketPageData
  const selections = market.plugins.filter(row => packages.includes(row.packageName)).map(({ packageName, version, status }) => ({ packageName, version, status }))
  expect(selections.find(row => row.packageName === nativePackage)).toMatchObject({ status: 'installed' })
  expect(selections.find(row => row.packageName === expertFixturePackage)).toMatchObject({ status: 'managed' })
  return { catalogSha256: retainedCatalogSha256, contentHash, installations, stored, plugins, access, grants, selections }
}

/** Only this invocation's tool result may satisfy the real-plugin observation. */
export function retainedPluginResult(body: { messages?: { content?: unknown }[] }, toolUseId: string): { failed: boolean; valid: boolean } | undefined {
  for (const message of body.messages ?? []) {
    if (!Array.isArray(message.content)) continue
    for (const block of message.content as { type?: string; tool_use_id?: string; is_error?: boolean; content?: unknown }[]) {
      if (block.type === 'tool_result' && block.tool_use_id === toolUseId)
        return { failed: block.is_error === true, valid: JSON.stringify(block.content ?? null).includes('PLATFORM_COPY') }
    }
  }
  return undefined
}
