import type { LibrarySkill } from '../domain/skill-library.js'
import type { SkillPack } from '../domain/skill-pack.js'
import type { SkillAssignmentsView } from '../ports/member-skills.js'
import type { SkillLibraryView } from '../ports/skill-library.js'
import type { SkillPackViews } from '../ports/skill-packs.js'
import type { PlatformDatabase, PlatformSql } from './platform-database.js'
import { PostgresCommittedView } from './postgres-committed-view.js'
import { PostgresSkillLibraryStore } from './postgres-skill-library.js'
import { PostgresSkillPackStore } from './postgres-skill-packs.js'

type Assignments = Readonly<Record<string, readonly string[]>>
interface SkillSnapshot {
  readonly library: readonly LibrarySkill[]
  readonly packs: readonly SkillPack[]
  readonly grants: Assignments
  readonly selections: Assignments
  readonly packGrants: Assignments
  readonly packSelections: Assignments
}
export const skillFactTables = [
  'accounts',
  'groups',
  'skills',
  'skill_runtime_dependencies',
  'skill_packs',
  'skill_pack_members',
  'skill_group_grants',
  'skill_selections',
  'pack_group_grants',
  'pack_selections',
  'skill_grant_receipts',
  'pack_grant_receipts',
].map(table => 'dsh_phalanx.' + table)

/** Sole publication owner for synchronous skill expansion and execution lookup, including parent cascades. */
export class PostgresSkillFacts {
  private readonly view: PostgresCommittedView<SkillSnapshot>
  readonly library: SkillLibraryView
  readonly grants: SkillAssignmentsView
  readonly selections: SkillAssignmentsView
  readonly packs: SkillPackViews
  constructor(database: PlatformDatabase) {
    this.view = new PostgresCommittedView(database, skillFactTables, () =>
      database.transaction(async sql => {
        await sql.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
        const connection = { sql, cipher: database.cipher() }
        return {
          library: await new PostgresSkillLibraryStore(connection).list(),
          packs: await new PostgresSkillPackStore(connection).list(),
          grants: await this.assignments(sql, 'skill_group_grants', 'group_id'),
          selections: await this.assignments(sql, 'skill_selections', 'space_id'),
          packGrants: await this.assignments(sql, 'pack_group_grants', 'group_id'),
          packSelections: await this.assignments(sql, 'pack_selections', 'space_id'),
        }
      }),
    )
    this.library = { list: () => this.view.read(snapshot => snapshot.library), ready: () => this.view.ready() }
    const assignmentView = (key: 'grants' | 'selections' | 'packGrants' | 'packSelections'): SkillAssignmentsView => ({
      get: id => this.view.read(snapshot => (Object.hasOwn(snapshot[key], id) ? snapshot[key][id]! : [])),
    })
    this.grants = assignmentView('grants')
    this.selections = assignmentView('selections')
    this.packs = {
      store: { list: () => this.view.read(snapshot => snapshot.packs) },
      grants: assignmentView('packGrants'),
      selections: assignmentView('packSelections'),
    }
  }
  initialize(): Promise<void> {
    return this.view.initialize()
  }
  close(): Promise<void> {
    return this.view.close()
  }
  private async assignments(sql: PlatformSql, table: string, key: string): Promise<Assignments> {
    const rows = await sql.query<{ id: string; name: string }>(`SELECT ${key} AS id,name FROM dsh_phalanx.${table} ORDER BY ${key},name`)
    const owners = new Map<string, string[]>()
    for (const row of rows) {
      const names = owners.get(row.id) ?? []
      names.push(row.name)
      owners.set(row.id, names)
    }
    return Object.fromEntries(owners)
  }
}
