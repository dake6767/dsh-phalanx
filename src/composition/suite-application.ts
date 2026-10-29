import type { PlatformDatabase } from '../adapters/platform-database.js'
import { HttpSuiteCatalogFetch } from '../adapters/suite-catalog-fetch.js'
import { YamlPluginAccessSyntax } from '../adapters/plugin-access-syntax.js'
import { officialSuiteCatalogKeys } from '../domain/suite-catalog-keys.js'
import type { TrustedSuiteCatalogKey } from '../domain/suite-catalog-signature.js'
import type { SuiteCatalogArchitecture } from '../domain/suite-catalog.js'
import type { CommunityAccountReaderPort } from '../ports/community-accounts.js'
import type { DownloadSourceReaderPort } from '../ports/download-sources.js'
import type { Clock } from '../ports/clock.js'
import { SuiteCatalogGallery } from '../use-cases/suite-catalog-gallery.js'
import { SuiteCatalog } from '../use-cases/suite-catalog.js'
import { SuitePlugins } from '../use-cases/suite-plugins.js'
import type { PluginLibrary } from '../use-cases/plugin-library.js'
import type { PluginAccessAdministration } from '../use-cases/plugin-access-administration.js'
import type { SkillLibrary } from '../use-cases/skill-library.js'
import type { SkillPacks } from '../use-cases/skill-packs.js'
import type { ExecutionAdministration } from '../use-cases/execution-administration.js'
import type { RuntimeDependencies } from '../use-cases/runtime-dependencies.js'
import { createSuiteStorage } from './suite-storage.js'

/** Catalog queries and prepared mutations share PostgreSQL facts and the same capability owners. */
export function createSuiteApplication(input: {
  readonly database: PlatformDatabase
  readonly accounts: Pick<CommunityAccountReaderPort, 'get'>
  readonly downloads: DownloadSourceReaderPort
  readonly clock: Clock
  readonly platformVersion: string
  readonly compatibilityTarget: string
  readonly architecture: SuiteCatalogArchitecture
  readonly catalog: { readonly address?: string; readonly trustedKeys?: readonly TrustedSuiteCatalogKey[] }
  readonly dependencies: RuntimeDependencies
  readonly skills: SkillLibrary
  readonly packs: SkillPacks
  readonly execution: ExecutionAdministration
  readonly plugins: PluginLibrary
  readonly access: PluginAccessAdministration
  readonly changed: () => Promise<void>
}): SuiteCatalog {
  const storage = createSuiteStorage(input.database)
  const gallery = new SuiteCatalogGallery({
    ...(input.catalog.address ? { configuredAddress: input.catalog.address } : {}),
    trustedKeys: input.catalog.trustedKeys ?? officialSuiteCatalogKeys,
    platformVersion: input.platformVersion,
    downloads: input.downloads,
    installs: async () => (await storage.installs.list()).map(row => row.record),
    fetcher: new HttpSuiteCatalogFetch(),
    log: line => console.warn(line),
  })
  return new SuiteCatalog(
    input.accounts,
    gallery,
    storage,
    input.dependencies,
    input.clock,
    input.architecture,
    input.skills,
    input.packs,
    input.execution,
    new SuitePlugins(input.plugins, input.access),
    { syntax: new YamlPluginAccessSyntax(), compatibilityTarget: input.compatibilityTarget, changed: input.changed },
  )
}
