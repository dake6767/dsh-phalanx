import { BusinessRuleError } from '../domain/business-error.js'
import type { LibrarySkill } from '../domain/skill-library.js'
import type { SkillRepositories } from '../ports/skill-unit-of-work.js'

export type SuiteSkillChange = { readonly kind: 'install'; readonly replacing: readonly LibrarySkill[] } | { readonly kind: 'update' }

/** Only prepared metadata enters the caller's fact transaction; artifact ownership stays with its preparation owner. */
export async function writeSuiteSkills(
  rows: Pick<SkillRepositories, 'library'>,
  origin: string,
  prepared: readonly LibrarySkill[],
  runtimeDependencies: readonly string[],
  change: SuiteSkillChange,
): Promise<readonly LibrarySkill[]> {
  const library = await rows.library.list()
  for (const row of prepared) {
    const current = library.find(skill => skill.name === row.name)
    if (change.kind === 'update') {
      if (current && current.suiteOrigin !== origin)
        throw new BusinessRuleError(
          'conflict',
          `Skill ${row.name} already exists with a different origin. Remove or rename it first.`,
          'suite-skill-conflict',
          {
            name: row.name,
          },
        )
    } else {
      const expected = change.replacing.find(skill => skill.name === row.name)
      if (current?.suiteOrigin === origin || (!current && !expected)) continue
      if (!current || !expected || current.suiteOrigin || current.hash !== expected.hash || current.source?.commit !== expected.source?.commit)
        throw new BusinessRuleError('conflict', 'The manual entries changed after the preview. Review the install again.', 'suite-replace-unconfirmed')
    }
  }
  const staged = prepared.map(row => {
    const current = library.find(skill => skill.name === row.name),
      replacing = change.kind === 'install' && change.replacing.length && current && !current.suiteOrigin
    return {
      ...row,
      ...(runtimeDependencies.length ? { runtimeDependencies: [...runtimeDependencies] } : {}),
      ...(current?.rowRevision !== undefined ? { rowRevision: current.rowRevision } : {}),
      ...(current && (change.kind === 'update' || replacing) ? { published: current.published } : {}),
      ...(current && change.kind === 'update' ? { importedAt: current.hash === row.hash ? current.importedAt : row.importedAt } : {}),
    }
  })
  for (const row of staged) await rows.library.save(row, row.rowRevision ?? 'none')
  return structuredClone(staged)
}
