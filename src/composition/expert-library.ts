import { randomUUID } from 'node:crypto'
import type { CommunityAccountStorePort } from '../ports/community-accounts.js'
import type { SkillLibraryStorePort } from '../ports/skill-library.js'
import type { SkillPackStorePort } from '../ports/skill-packs.js'
import type { CommunityRuntimePort } from '../ports/community-runtime.js'
import type { McpStatePort } from '../ports/mcp-services.js'
import type { SharedModelStorePort } from '../ports/shared-models.js'
import type { LibraryPlugin } from '../domain/plugin-library.js'
import type { PlatformDatabase } from '../adapters/platform-database.js'
import { enabledSharedModels } from '../domain/shared-models.js'
import { YamlPluginAccessSyntax } from '../adapters/plugin-access-syntax.js'
import { Experts } from '../use-cases/experts.js'
import { createExpertStorage } from './expert-storage.js'

/** Capability sources stay lazy because the mutually dependent runtime owners are wired together. */
export function createExpertLibrary(
  database: PlatformDatabase,
  sources: {
    readonly accounts: Pick<CommunityAccountStorePort, 'get' | 'list' | 'listGroups'>
    readonly skills: Pick<SkillLibraryStorePort, 'list'>
    readonly packs: Pick<SkillPackStorePort, 'list'>
    readonly changed: () => Promise<void>
    readonly globalSkills: (username: string) => Promise<readonly string[]>
    readonly status: CommunityRuntimePort['status']
    readonly plugins: () => Promise<readonly LibraryPlugin[]>
    readonly mcp: Pick<McpStatePort, 'read'>
    readonly models: Pick<SharedModelStorePort, 'read'>
  },
) {
  const storage = createExpertStorage(database)
  const experts = new Experts(
    sources.accounts,
    storage,
    sources.skills,
    sources.packs,
    randomUUID,
    sources.changed,
    sources.globalSkills,
    { status: sources.status },
    { list: sources.plugins, eligible: plugin => new YamlPluginAccessSyntax().expertEligible(plugin) },
    async () => (await sources.mcp.read()).services.map(row => ({ name: row.name, description: row.description })),
    () =>
      enabledSharedModels(sources.models.read()).map(({ provider, model }) => ({
        providerId: provider.id,
        name: model.name,
        id: model.id,
        label: `${provider.name} / ${model.name}`,
      })),
  )
  return { experts, storage }
}
