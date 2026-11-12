import { randomUUID } from 'node:crypto'
import { BusinessRuleError } from '../domain/business-error.js'
import type { NativeFeatureGroupState, NativeFeatureMember, NativeFeatureRows } from '../ports/native-features.js'
import { repositorySql, repositoryTransaction, type RowRepositoryConnection } from './postgres-row-repository.js'

interface FeatureRow {
  group_id: string
  row_revision: string | null
  disabled_ids: string[] | null
  show_app_center: boolean | null
}
function groupState(row: FeatureRow): NativeFeatureGroupState {
  return { groupId: row.group_id, revision: row.row_revision ?? 'none', disabledIds: row.disabled_ids ?? [], showAppCenter: row.show_app_center === true }
}

/** One aggregate row per group; member startup reads membership and its selection together. */
export class PostgresNativeFeatures implements NativeFeatureRows {
  constructor(private readonly connection: RowRepositoryConnection) {}

  async readGroup(groupId: string): Promise<NativeFeatureGroupState | undefined> {
    const row = (
      await repositorySql(this.connection).query<FeatureRow>(
        `SELECT g.id AS group_id,s.row_revision,s.disabled_ids,s.show_app_center FROM dsh_phalanx.groups g
       LEFT JOIN dsh_phalanx.native_feature_group_settings s ON s.group_id=g.id WHERE g.id=$1`,
        [groupId],
      )
    )[0]
    return row ? groupState(row) : undefined
  }
  async forMember(member: NativeFeatureMember): Promise<NativeFeatureGroupState | undefined> {
    const row = (
      await repositorySql(this.connection).query<FeatureRow>(
        `SELECT g.id AS group_id,s.row_revision,s.disabled_ids,s.show_app_center FROM dsh_phalanx.accounts a
       JOIN dsh_phalanx.groups g ON g.id=a.group_id
       LEFT JOIN dsh_phalanx.native_feature_group_settings s ON s.group_id=g.id
       WHERE a.username=$1 AND a.space_id=$2 AND NOT a.disabled`,
        [member.username, member.spaceId],
      )
    )[0]
    return row ? groupState(row) : undefined
  }
  save(groupId: string, disabledIds: readonly string[], expectedRevision: string, showAppCenter?: boolean): Promise<NativeFeatureGroupState> {
    return repositoryTransaction(this.connection, async sql => {
      const parent = await sql.query('SELECT id FROM dsh_phalanx.groups WHERE id=$1 FOR KEY SHARE', [groupId])
      if (!parent.length) throw new BusinessRuleError('missing', 'Group not found', 'group-not-found')
      const revision = randomUUID()
      const rows = await sql.query<FeatureRow>(
        expectedRevision === 'none'
          ? `INSERT INTO dsh_phalanx.native_feature_group_settings(group_id,disabled_ids,row_revision,show_app_center) VALUES($1,$2,$3,$4)
             ON CONFLICT(group_id) DO NOTHING RETURNING group_id,disabled_ids,row_revision,show_app_center`
          : `UPDATE dsh_phalanx.native_feature_group_settings SET disabled_ids=$2,row_revision=$3,show_app_center=COALESCE($5,show_app_center)
             WHERE group_id=$1 AND row_revision=$4 RETURNING group_id,disabled_ids,row_revision,show_app_center`,
        expectedRevision === 'none'
          ? [groupId, [...disabledIds], revision, showAppCenter ?? false]
          : [groupId, [...disabledIds], revision, expectedRevision, showAppCenter ?? null],
      )
      if (!rows[0]) throw new BusinessRuleError('conflict', 'Native feature settings changed. Reload and review them again.', 'native-features-stale')
      return groupState(rows[0])
    })
  }
}
