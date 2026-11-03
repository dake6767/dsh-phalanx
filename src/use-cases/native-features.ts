import type { CommunityNativeFeatureGroup, CommunityNativeFeatureInput } from '../domain/admin-contract.js'
import { BusinessRuleError } from '../domain/business-error.js'
import type { CommunityAccountActor } from '../domain/community-account.js'
import { effectiveDisabledNativeFeatures, mergeNativeFeatureSelection, nativeFeatureView, type NativeFeatureDefinition } from '../domain/native-features.js'
import type { MemberNativeFeaturesPort, NativeFeatureGroupState, NativeFeatureMember, NativeFeaturePersistence } from '../ports/native-features.js'

/** Group choices are fresh facts at startup; saving never changes a running instance. */
export class NativeFeatures implements MemberNativeFeaturesPort {
  constructor(
    private readonly catalog: readonly NativeFeatureDefinition[],
    private readonly persistence: NativeFeaturePersistence,
  ) {}

  group(actor: CommunityAccountActor, groupId: string): Promise<CommunityNativeFeatureGroup> {
    return this.persistence.work.run(async repositories => {
      await repositories.actors.lockAdministrator(actor)
      const state = await repositories.features.readGroup(groupId)
      if (!state) throw new BusinessRuleError('missing', 'Group not found', 'group-not-found')
      return this.view(state)
    })
  }
  save(actor: CommunityAccountActor, groupId: string, input: CommunityNativeFeatureInput): Promise<CommunityNativeFeatureGroup> {
    return this.persistence.work.run(async repositories => {
      await repositories.actors.lockAdministrator(actor)
      const state = await repositories.features.readGroup(groupId)
      if (!state) throw new BusinessRuleError('missing', 'Group not found', 'group-not-found')
      if (input.revision !== this.revision(state))
        throw new BusinessRuleError('conflict', 'Native feature settings changed. Reload and review them again.', 'native-features-stale')
      const disabledIds = mergeNativeFeatureSelection(this.catalog, state.disabledIds, input.disabledIds)
      return this.view(await repositories.features.save(groupId, disabledIds, state.revision))
    })
  }
  async resolve(member: NativeFeatureMember) {
    const state = await this.persistence.rows.forMember(member)
    if (!state) throw new BusinessRuleError('forbidden', 'The member is no longer active in this space.', 'account-inactive')
    return { disabledIds: effectiveDisabledNativeFeatures(this.catalog, state.disabledIds) }
  }
  private view(state: NativeFeatureGroupState): CommunityNativeFeatureGroup {
    return { groupId: state.groupId, revision: this.revision(state), features: nativeFeatureView(this.catalog, state.disabledIds) }
  }
  private revision(state: NativeFeatureGroupState): string {
    // A form from another build must not erase newly recognized, previously unknown choices.
    const catalog = this.catalog.map(feature => [feature.id, feature.availability.available, feature.constraints.map(rule => [rule.kind, rule.group])])
    return JSON.stringify([state.groupId, state.revision, catalog])
  }
}
