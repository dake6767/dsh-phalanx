import type { CommunityPluginView } from '../domain/admin-contract.js'
import { BusinessRuleError } from '../domain/business-error.js'
import type { CommunityAccountActor } from '../domain/community-account.js'
import { assertPluginContributionVersion, libraryContributionProvenance, type LibraryContributionAdoption } from '../domain/library-contribution.js'
import { assertPluginDependencyTemplate } from '../domain/plugin-access.js'
import {
  assertPluginIdentity,
  assertPreparedPlugin,
  pluginIdentities,
  pluginLibraryView,
  pluginMaintenanceRevision,
  PluginPreparationError,
  type LibraryPlugin,
  type PluginCandidate,
} from '../domain/plugin-library.js'
import type { CommunityAccountStorePort } from '../ports/community-accounts.js'
import type { PluginAccessStorePort } from '../ports/plugin-access.js'
import type { PluginLibraryStorePort } from '../ports/plugin-library.js'
import type { RuntimeDependencies } from './runtime-dependencies.js'
import { KeyedOperations } from './support/keyed-operations.js'

/** Administrative edits share the library's package queue and authorization policy. */
export class PluginLibraryAdministration {
  constructor(
    private readonly accounts: Pick<CommunityAccountStorePort, 'get'>,
    private readonly store: PluginLibraryStorePort,
    private readonly compatibilityTarget: string | undefined,
    private readonly settings: { readonly access: Partial<Pick<PluginAccessStorePort, 'get'>> } | undefined,
    private readonly runtimeDependencies: Pick<RuntimeDependencies, 'readReady'> | undefined,
    private readonly operations: KeyedOperations,
    private readonly owner: {
      assertAdmin(actor: CommunityAccountActor): Promise<void>
      assertIdle(name: string): void
      assertWritable(name: string): Promise<void>
      confirm(actor: CommunityAccountActor, name: string, revision: string): Promise<void>
      required(name: string): Promise<LibraryPlugin>
    },
  ) {}
  /** A contribution has already passed the same isolated preparer; selection still belongs to this owner. */
  async adoptContribution(
    actor: CommunityAccountActor,
    candidate: PluginCandidate,
    prepared: import('../domain/plugin-library.js').PreparedPlugin,
    revision: string,
    contribution: {
      readonly id: string
      readonly revision: string
      readonly checkedFor?: string
      readonly adoption?: LibraryContributionAdoption
      readonly commit?: (plugin: LibraryPlugin, committed: () => void) => Promise<void>
    },
    committed: () => void,
  ): Promise<void> {
    return await this.operations.run(candidate.packageName, async () => {
      await this.owner.assertAdmin(actor)
      assertPluginIdentity(candidate)
      this.owner.assertIdle(candidate.packageName)
      await this.owner.assertWritable(candidate.packageName)
      if (
        this.compatibilityTarget &&
        (contribution.checkedFor !== this.compatibilityTarget || prepared.runtimeRevision !== this.compatibilityTarget.split('/').at(-1))
      )
        throw new PluginPreparationError('plugin-incompatible')
      const existing = (await this.store.list()).find(row => row.packageName === candidate.packageName)
      if (existing) {
        if (existing.removing) throw new BusinessRuleError('conflict', 'Plugin removal is pending.', 'plugin-job-busy')
        await this.owner.confirm(actor, candidate.packageName, revision)
      } else if (revision !== 'new') throw new BusinessRuleError('conflict', 'Review the changed plugin impact.', 'plugin-impact-changed')
      let provenance = existing?.provenance
      if (contribution.adoption) {
        const submitted = contribution.adoption.row
        if ((await this.accounts.get(submitted.contributor.username))?.spaceId !== submitted.contributor.spaceId)
          throw new BusinessRuleError('conflict', 'The contributor account changed.', 'contribution-unavailable')
        assertPluginContributionVersion(candidate.version, existing?.current?.version)
        provenance = libraryContributionProvenance(provenance, contribution.adoption, !!existing)
      }
      const identities = existing ? pluginIdentities(existing) : {}
      assertPreparedPlugin(candidate, prepared, identities[candidate.version])
      const row: LibraryPlugin = {
        ...candidate,
        ...(existing?.revision !== undefined ? { revision: existing.revision } : {}),
        runtimeDependencies: existing?.runtimeDependencies ?? [],
        ...(provenance ? { provenance } : {}),
        contributionReceipt: { id: contribution.id, revision: contribution.revision },
        current: prepared,
        stage: 'available',
        published: existing?.published === true || existing?.restorePublication === true,
        identities: { ...identities, [candidate.version]: prepared.integrity },
        ...(this.compatibilityTarget ? { checkedFor: this.compatibilityTarget } : {}),
      }
      let notified = false
      const notify = () => {
        if (!notified) {
          notified = true
          committed()
        }
      }
      if (contribution.commit) await contribution.commit(row, notify)
      else {
        await this.store.save(row, existing?.revision ?? 'none')
        notify()
      }
    })
  }
  async setRuntimeDependencies(actor: CommunityAccountActor, packageName: string, names: readonly string[]): Promise<CommunityPluginView> {
    return await this.operations.run(packageName, async () => {
      await this.owner.assertAdmin(actor)
      this.owner.assertIdle(packageName)
      await this.owner.assertWritable(packageName)
      const row = await this.owner.required(packageName)
      if (
        row.removing ||
        !Array.isArray(names) ||
        names.some(name => typeof name !== 'string') ||
        new Set(names).size !== names.length ||
        !this.runtimeDependencies
      )
        throw new BusinessRuleError('invalid', 'Select existing runtime dependencies.', 'runtime-dependency-invalid')
      await this.runtimeDependencies.readReady(names)
      for (const setting of (await this.settings?.access.get?.(packageName))?.environment ?? []) assertPluginDependencyTemplate(setting.value, new Set(names))
      await this.store.save({ ...row, runtimeDependencies: [...names] })
      return pluginLibraryView(await this.owner.required(packageName))
    })
  }
  async setMaintainer(actor: CommunityAccountActor, packageName: string, username: string | null, revision: string): Promise<CommunityPluginView> {
    return await this.operations.run(packageName, async () => {
      await this.owner.assertAdmin(actor)
      this.owner.assertIdle(packageName)
      await this.owner.assertWritable(packageName)
      const row = await this.owner.required(packageName)
      if (revision !== pluginMaintenanceRevision(row)) throw new BusinessRuleError('conflict', 'Review the changed plugin ownership.', 'plugin-impact-changed')
      const target = username === null ? undefined : await this.accounts.get(username)
      if (username !== null && (!target || target.disabled)) throw new BusinessRuleError('invalid', 'Choose a current member.', 'contribution-invalid')
      await this.store.save({
        ...row,
        provenance: {
          anonymous: row.provenance?.anonymous ?? false,
          versions: row.provenance?.versions ?? [],
          maintainer: target ? { username: target.username, spaceId: target.spaceId } : null,
        },
      })
      return pluginLibraryView(await this.owner.required(packageName))
    })
  }
}
