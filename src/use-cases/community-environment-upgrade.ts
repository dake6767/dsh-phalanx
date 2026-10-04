import type { CommunityEnvironmentPort } from '../ports/community-environment.js'
import type { CommunityEnvironmentUpgradePort, CommunityEnvironmentUpgradeStorePort } from '../ports/community-environment-upgrade.js'
import { CommunityRuntimeUnavailableError } from '../ports/community-runtime.js'

/** Legacy configuration is backed up before upstream migration; admin model edits remain untouched. */
export class CommunityEnvironmentUpgrade implements CommunityEnvironmentUpgradePort {
  constructor(private readonly store: CommunityEnvironmentUpgradeStorePort,
    private readonly environment: Pick<CommunityEnvironmentPort, 'backup'>) {}
  async prepare(username: string, spaceId: string): Promise<{ selectSharedModel: boolean }> {
    try {
      const state = await this.store.inspect(username, spaceId)
      if (state.state === 'complete') return { selectSharedModel: state.selectSharedModel }
      const backup = state.state === 'legacy' ? await this.environment.backup(username, spaceId) : undefined
      const selectSharedModel = state.state === 'legacy'
      await this.store.complete(username, spaceId, { selectSharedModel, ...(backup === undefined ? {} : { backup }) })
      return { selectSharedModel }
    } catch (cause) {
      throw new CommunityRuntimeUnavailableError('upgrade-unavailable', 'DSH upgrade preparation failed. The original environment was retained; resolve backup or migration storage and retry.', { cause })
    }
  }
}
