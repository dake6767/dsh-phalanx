import type { CommunityAccountActor } from '../domain/community-account.js'
import type { LibrarySkill } from '../domain/skill-library.js'
import type { SkillPack } from '../domain/skill-pack.js'

/** Approved batch; retained until every carrier and member projection has converged. */
export interface SkillImportIntent {
  readonly removals?: readonly string[]
  readonly token: string
  readonly actor: CommunityAccountActor
  readonly skills: readonly LibrarySkill[]
  readonly packs: readonly SkillPack[]
}
export interface SkillImportIntentPort {
  get(): SkillImportIntent | undefined
  save(intent: SkillImportIntent): void
  clear(): void
}
