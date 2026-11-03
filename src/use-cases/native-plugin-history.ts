import { BusinessRuleError } from '../domain/business-error.js'
import type { CommunityUserInstance } from '../ports/community-runtime.js'
import type { NativeFeatureMember } from '../ports/native-features.js'
import type {
  MemberNativePluginHistory,
  NativeOptionalBundle,
  NativePluginHistoryPersistence,
  NativePluginHistoryRuntime,
} from '../ports/native-plugin-history.js'

/** Eligibility is an append-only platform fact scoped to the current user space. */
export class NativePluginHistory implements MemberNativePluginHistory {
  constructor(
    private readonly persistence: NativePluginHistoryPersistence,
    private readonly runtime: NativePluginHistoryRuntime,
  ) {}
  async initialize(member: NativeFeatureMember, instance: CommunityUserInstance, signal: AbortSignal): Promise<readonly string[]> {
    this.assertTarget(member, instance)
    const bundles = await this.runtime.inspect(instance, signal)
    signal.throwIfAborted()
    return this.record(member, bundles)
  }
  async request(member: NativeFeatureMember, generation: string, mode: 'read' | 'refresh', signal: AbortSignal): Promise<readonly string[]> {
    const instance = this.runtime.current(member.username)
    this.assertTarget(member, instance, generation)
    const bundles = mode === 'refresh' ? await this.runtime.inspect(instance!, signal) : undefined
    signal.throwIfAborted()
    this.assertTarget(member, this.runtime.current(member.username), generation)
    return this.record(member, bundles, () => {
      signal.throwIfAborted()
      this.assertTarget(member, this.runtime.current(member.username), generation)
    })
  }
  private record(member: NativeFeatureMember, bundles?: readonly NativeOptionalBundle[], assertCurrent: () => void = () => {}): Promise<readonly string[]> {
    return this.persistence.work.run(async repositories => {
      await repositories.actors.lockMember(member)
      assertCurrent()
      const existing = await repositories.history.read(member.spaceId)
      if (!bundles) {
        if (!existing) throw new BusinessRuleError('conflict', 'Native plugin history is not initialized.', 'native-plugin-history-unavailable')
        return existing
      }
      const eligible = bundles
        .filter(bundle => (existing === undefined ? bundle.enabled || bundle.installed : bundle.enabled && !bundle.failed))
        .map(bundle => bundle.name)
      return repositories.history.remember(member.spaceId, eligible)
    })
  }
  private assertTarget(member: NativeFeatureMember, instance: CommunityUserInstance | undefined, generation?: string): void {
    if (
      !instance ||
      instance.userId !== member.username ||
      instance.spaceId !== member.spaceId ||
      !instance.resourceKey ||
      (generation !== undefined && instance.resourceKey !== generation)
    )
      throw new BusinessRuleError('forbidden', 'The native plugin request belongs to an inactive instance.', 'native-plugin-instance-stale')
  }
}
