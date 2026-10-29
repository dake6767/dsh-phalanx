import type { PlatformTransaction } from './postgres-unit-of-work.js'
import type { CommunityAccountActor } from '../domain/community-account.js'
import type { MemberContribution } from '../domain/member-contribution.js'
import type { LibraryProvenance } from '../domain/library-contribution.js'
import { assertContributionMaintainer, assertPluginContributionVersion } from '../domain/library-contribution.js'
import { BusinessRuleError } from '../domain/business-error.js'

/** The intake precheck is advisory; ownership must still hold when the pending row commits. */
export class PostgresContributionSubmission {
  constructor(private readonly transaction: PlatformTransaction) {}
  async check(actor: CommunityAccountActor, contribution: MemberContribution): Promise<void> {
    const plugin = contribution.kind === 'plugin',
      table = plugin ? 'plugin_library' : 'skills',
      column = plugin ? 'package_name' : 'name'
    const [row] = await this.transaction.sql.query<{ provenance: LibraryProvenance | null; suite_origin: string | null; current: { version: string } | null }>(
      `SELECT provenance,suite_origin,${plugin ? 'current' : 'NULL::jsonb AS current'} FROM dsh_phalanx.${table} WHERE ${column}=$1 FOR SHARE`,
      [contribution.name],
    )
    if (row?.suite_origin) throw new BusinessRuleError('forbidden', 'Catalog entries are read-only.', 'suite-entry-locked')
    assertContributionMaintainer(row?.provenance ?? undefined, actor)
    if (plugin && contribution.plugin) assertPluginContributionVersion(contribution.plugin.prepared.version, row?.current?.version)
  }
}
