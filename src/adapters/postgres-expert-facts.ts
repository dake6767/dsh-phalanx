import type { ExpertPolicyView, ExpertSnapshot } from '../ports/experts.js'
import type { PlatformDatabase } from './platform-database.js'
import { PostgresCommittedView } from './postgres-committed-view.js'
import { PostgresExpertStateQuery } from './postgres-expert-state-query.js'

export const expertFactTables = [
  'accounts',
  'groups',
  'experts',
  'expert_metadata',
  'expert_skills',
  'expert_skill_packs',
  'expert_plugins',
  'expert_mcp',
  'expert_models',
  'expert_group_settings',
  'expert_grants',
  'expert_member_settings',
  'expert_selections',
  'skills',
  'skill_packs',
  'plugin_library',
  'mcp_services',
].map(table => 'dsh_phalanx.' + table)

/** Only synchronous authorization fences use this registered committed publication. */
export class PostgresExpertFacts implements ExpertPolicyView {
  private readonly committed: PostgresCommittedView<ExpertSnapshot>
  constructor(database: PlatformDatabase) {
    this.committed = new PostgresCommittedView(database, expertFactTables, () => new PostgresExpertStateQuery(database).read())
  }
  initialize(): Promise<void> {
    return this.committed.initialize()
  }
  close(): Promise<void> {
    return this.committed.close()
  }
  read(): ExpertSnapshot {
    return this.committed.read(snapshot => snapshot)
  }
  version(): string {
    return this.committed.read(snapshot => snapshot.publicRevision)
  }
}
