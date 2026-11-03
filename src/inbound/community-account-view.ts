import type { CommunityAccountView } from '../domain/admin-contract.js'
import type { CommunityAccountRecord } from '../domain/community-account.js'
import type { CommunityRuntimePort } from '../ports/community-runtime.js'
import type { CommunityEnvironmentRecovery } from '../use-cases/community-environment-recovery.js'
import type { InstanceResources } from '../use-cases/instance-resources.js'

export async function communityAccountView(
  account: CommunityAccountRecord,
  environment: CommunityEnvironmentRecovery,
  runtime: Pick<CommunityRuntimePort, 'status'>,
  resources?: InstanceResources,
): Promise<CommunityAccountView> {
  const recent = await environment.lastRequestedFor(account)
  return {
    ...(recent === undefined ? {} : { lastEnvironmentReset: recent }),
    username: account.username,
    groupId: account.groupId,
    spaceId: account.spaceId,
    email: account.email,
    admin: account.admin,
    disabled: account.disabled,
    instance: {
      state: runtime.status(account.username).state,
      ...(resources ? { resourcePending: await resources.pendingFor(account) } : {}),
    },
  }
}
