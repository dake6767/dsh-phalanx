import type { CommunityGroupRecord } from './community-group.js'
import type { CommunityAccountRecord } from './community-account.js'
import type { LibraryPlugin } from './plugin-library.js'

/** The confirmed group impact uses the same ordering in review and commit. */
export function pluginGroupRevision(
  group: CommunityGroupRecord | undefined,
  controlled: readonly string[],
  preinstalled: readonly string[],
  library: readonly LibraryPlugin[],
  accounts: readonly Pick<CommunityAccountRecord, 'spaceId' | 'groupId' | 'disabled'>[],
): string {
  return JSON.stringify([
    group,
    [...controlled].sort(),
    [...preinstalled].sort(),
    library.map(row => [row.packageName, row.version, row.current?.integrity, row.stage, row.removing]),
    accounts.map(account => [account.spaceId, account.groupId, account.disabled]).sort(),
  ])
}
