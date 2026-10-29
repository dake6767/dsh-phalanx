import { BusinessRuleError } from '../domain/business-error.js'
import type { LibrarySkill } from '../domain/skill-library.js'
import type { SkillLibraryStorePort } from '../ports/skill-library.js'
import { PostgresRuntimeReferences } from './postgres-runtime-references.js'
import { repositorySql, repositoryTransaction, type RowRepositoryConnection } from './postgres-row-repository.js'

interface SkillRow {
  name: string
  description: string
  hash: string
  imported_at: string
  published: boolean
  conflict: boolean | null
  source: NonNullable<LibrarySkill['source']> | null
  provenance: NonNullable<LibrarySkill['provenance']> | null
  suite_origin: string | null
  dependencies: readonly string[]
  runtime_dependencies: readonly string[] | null
  contribution_receipt: NonNullable<LibrarySkill['contributionReceipt']> | null
  publication_receipt: NonNullable<LibrarySkill['contributionPublicationReceipt']> | null
  distribution_receipt: NonNullable<LibrarySkill['contributionDistributionReceipt']> | null
  revision: string
}

/** Skill rows are read on demand; a separate registered owner publishes synchronous views. */
export class PostgresSkillLibraryStore implements SkillLibraryStorePort {
  constructor(private readonly connection: RowRepositoryConnection) {}
  async list(): Promise<readonly LibrarySkill[]> {
    return (
      await repositorySql(this.connection).query<SkillRow>(
        `SELECT skills.*,ARRAY(SELECT dependency FROM dsh_phalanx.skill_runtime_dependencies WHERE owner_id=skills.name AND owner_scope='current' ORDER BY position) AS dependencies FROM dsh_phalanx.skills ORDER BY name`,
      )
    ).map(row => ({
      name: row.name,
      description: row.description,
      hash: row.hash,
      importedAt: Number(row.imported_at),
      published: row.published,
      rowRevision: Number(row.revision),
      ...(row.conflict === null ? {} : { conflict: row.conflict }),
      ...(row.source === null ? {} : { source: row.source }),
      ...(row.provenance === null ? {} : { provenance: row.provenance }),
      ...(row.suite_origin === null ? {} : { suiteOrigin: row.suite_origin }),
      ...(row.runtime_dependencies === null && !row.dependencies.length ? {} : { runtimeDependencies: row.dependencies }),
      ...(row.contribution_receipt === null ? {} : { contributionReceipt: row.contribution_receipt }),
      ...(row.publication_receipt === null ? {} : { contributionPublicationReceipt: row.publication_receipt }),
      ...(row.distribution_receipt === null ? {} : { contributionDistributionReceipt: row.distribution_receipt }),
    }))
  }
  async save(skill: LibrarySkill, expectedRevision: number | 'none' | undefined = skill.rowRevision): Promise<void> {
    const values = [
      skill.name,
      skill.description,
      skill.hash,
      skill.importedAt,
      skill.published,
      skill.conflict ?? null,
      skill.source ? JSON.stringify(skill.source) : null,
      skill.provenance ? JSON.stringify(skill.provenance) : null,
      skill.suiteOrigin ?? null,
      skill.runtimeDependencies ? '[]' : null,
      skill.contributionReceipt ? JSON.stringify(skill.contributionReceipt) : null,
      skill.contributionPublicationReceipt ? JSON.stringify(skill.contributionPublicationReceipt) : null,
      skill.contributionDistributionReceipt ? JSON.stringify(skill.contributionDistributionReceipt) : null,
    ]
    await repositoryTransaction(this.connection, async sql => {
      const result = await sql.query(
        typeof expectedRevision !== 'number'
          ? `INSERT INTO dsh_phalanx.skills(name,description,hash,imported_at,published,conflict,source,provenance,suite_origin,runtime_dependencies,contribution_receipt,publication_receipt,distribution_receipt)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ${
            expectedRevision === 'none'
              ? 'ON CONFLICT(name) DO NOTHING RETURNING revision'
              : `ON CONFLICT(name) DO UPDATE SET
          description=EXCLUDED.description,hash=EXCLUDED.hash,imported_at=EXCLUDED.imported_at,published=EXCLUDED.published,conflict=EXCLUDED.conflict,
          source=EXCLUDED.source,provenance=EXCLUDED.provenance,suite_origin=EXCLUDED.suite_origin,runtime_dependencies=EXCLUDED.runtime_dependencies,
          contribution_receipt=EXCLUDED.contribution_receipt,publication_receipt=EXCLUDED.publication_receipt,distribution_receipt=EXCLUDED.distribution_receipt,
          revision=skills.revision+1 RETURNING revision`
          }`
          : `UPDATE dsh_phalanx.skills SET description=$2,hash=$3,imported_at=$4,published=$5,conflict=$6,source=$7,provenance=$8,suite_origin=$9,
          runtime_dependencies=$10,contribution_receipt=$11,publication_receipt=$12,distribution_receipt=$13,revision=revision+1 WHERE name=$1 AND revision=$14 RETURNING revision`,
        typeof expectedRevision !== 'number' ? values : [...values, expectedRevision],
      )
      if (!result.length) throw new BusinessRuleError('conflict', 'Review the skill again before confirming.', 'skill-preview-changed')
      const cipher = 'sql' in this.connection ? this.connection.cipher : this.connection.cipher()
      await new PostgresRuntimeReferences({ sql, cipher }).replace({ kind: 'skill', name: skill.name }, skill.runtimeDependencies ?? [])
    })
  }
  async remove(name: string, expectedRevision?: number): Promise<void> {
    const removed = await repositorySql(this.connection).query(
      expectedRevision === undefined
        ? 'DELETE FROM dsh_phalanx.skills WHERE name=$1 RETURNING name'
        : 'DELETE FROM dsh_phalanx.skills WHERE name=$1 AND revision=$2 RETURNING name',
      expectedRevision === undefined ? [name] : [name, expectedRevision],
    )
    if (expectedRevision !== undefined && !removed.length)
      throw new BusinessRuleError('conflict', 'Review the skill again before confirming.', 'skill-preview-changed')
  }
}
