import { BusinessRuleError } from '../domain/business-error.js'
import type { ExpertReferenceImpact } from '../domain/expert-reference.js'
import type { LibrarySkill } from '../domain/skill-library.js'
import type { ExpertReferencesPort } from '../ports/experts.js'
import { skillImpactRevision } from '../domain/skill-impact.js'
import type { SkillLibraryStorePort } from '../ports/skill-library.js'
import type { SkillPackState } from '../ports/skill-packs.js'
import type { SkillMembership } from './skill-membership.js'
import type { SkillRepositories } from '../ports/skill-unit-of-work.js'

/** The confirmed impact and the skill row must still match inside the deletion transaction. */
export class SkillLibraryRemoval {
  constructor(
    private readonly references: ExpertReferencesPort | undefined,
    private readonly store: SkillLibraryStorePort,
    private readonly membership: SkillMembership | undefined,
    private readonly packs: SkillPackState | undefined,
    private readonly transaction: (operation: (repositories: SkillRepositories) => Promise<void>) => Promise<void>,
  ) {}
  async revision(name: string, expertImpact?: ExpertReferenceImpact, captured?: LibrarySkill): Promise<string> {
    const row = captured ?? (await this.store.list()).find(row => row.name === name)
    return skillImpactRevision(
      row,
      await this.membership?.revision(name),
      await this.packs?.store.list(),
      name,
      expertImpact?.revision ?? (await this.references?.impact([{ kind: 'skill', name }]))?.revision,
    )
  }
  async remove(row: LibrarySkill, revision: string): Promise<void> {
    const targets = [{ kind: 'skill' as const, name: row.name }]
    const impact = await this.references?.impact(targets)
    if (revision !== (await this.revision(row.name, impact, row)))
      throw new BusinessRuleError('conflict', 'Review the skill again before confirming.', 'skill-preview-changed')
    await this.transaction(async rows => {
      if (impact) {
        if (!rows.expertReferences) throw Error('Expert reference retirement requires a shared transaction')
        await rows.expertReferences.detach(targets, impact.revision)
      }
      await rows.library.remove(row.name, row.rowRevision)
    })
  }
}
