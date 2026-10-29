import type { CommunityPluginImpact } from '../domain/admin-contract.js'
import { BusinessRuleError } from '../domain/business-error.js'
import { pluginImpact } from '../domain/plugin-impact.js'
import type { LibraryPlugin } from '../domain/plugin-library.js'
import type { ExpertReferenceImpact } from '../domain/expert-reference.js'
import type { ExpertReferencesPort } from '../ports/experts.js'
import type { PluginLibraryStorePort, PluginLibraryMembershipPort, PluginRemovalRepositories } from '../ports/plugin-library.js'
import type { PlatformUnitOfWorkPort } from '../ports/platform-unit-of-work.js'
import type { PluginAccessStorePort } from '../ports/plugin-access.js'
import type { PluginUpstreamsPort } from '../ports/plugin-upstreams.js'

/** Captures the reviewed plugin and expert references, then retires both in one transaction. */
export class PluginLibraryRemoval {
  constructor(
    private readonly store: PluginLibraryStorePort,
    private readonly membership: PluginLibraryMembershipPort | undefined,
    private readonly settings: { readonly access: Pick<PluginAccessStorePort, 'remove'>; readonly upstreams: Pick<PluginUpstreamsPort, 'save'> } | undefined,
    private readonly work: PlatformUnitOfWorkPort<PluginRemovalRepositories> | undefined,
    private readonly references: ExpertReferencesPort | undefined,
  ) {}
  private async capture(packageName: string) {
    const row = (await this.store.list()).find(row => row.packageName === packageName)
    if (!row) throw new BusinessRuleError('missing', 'Plugin was not found.', 'plugin-market-unavailable')
    if (!this.membership) throw new BusinessRuleError('invalid', 'Plugin changes are unavailable.', 'plugin-action-invalid')
    const members = await this.membership.impact(packageName),
      references = await this.references?.impact([{ kind: 'plugin', name: packageName }])
    const impact = pluginImpact(row, members, references)
    return { row, references, impact }
  }
  async impact(packageName: string): Promise<CommunityPluginImpact> {
    return (await this.capture(packageName)).impact
  }
  async remove(packageName: string, revision: string): Promise<void> {
    const captured = await this.capture(packageName)
    if (captured.impact.revision !== revision) throw new BusinessRuleError('conflict', 'The plugin impact changed. Review it again.', 'plugin-impact-changed')
    await this.retire(captured.row, captured.references)
  }
  async finish(packageName: string): Promise<void> {
    const row = (await this.store.list()).find(row => row.packageName === packageName)
    if (!row) return
    await this.retire(row, await this.references?.impact([{ kind: 'plugin', name: packageName }]))
  }
  private async retire(row: LibraryPlugin, references?: ExpertReferenceImpact): Promise<void> {
    if (this.work) {
      await this.work.run(async repositories => {
        if (references) {
          if (!repositories.expertReferences) throw Error('Expert reference retirement requires a shared transaction')
          await repositories.expertReferences.detach([{ kind: 'plugin', name: row.packageName }], references.revision)
        }
        await repositories.library.remove(row.packageName, row.revision)
      })
      return
    }
    if (references) throw Error('Expert reference retirement requires a shared transaction')
    if (!this.membership) throw Error('Plugin membership is required for removal')
    await this.membership.revoke(row.packageName)
    await this.settings?.access.remove(row.packageName)
    await this.settings?.upstreams.save(row.packageName, [])
    await this.store.remove(row.packageName, row.revision)
  }
}
