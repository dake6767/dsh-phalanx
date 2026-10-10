import { bundledSkillNames, bundledSkillRevision } from '../dsh/bundled-skills.js'
import { declaredRuntimeRevision } from './runtime-revision.js'
/** Refuse an unreviewed runtime update with stale reserved skill names. */
export function runtimeSkillNames(): readonly string[] {
  if (bundledSkillRevision !== declaredRuntimeRevision()) throw new Error('Regenerate bundled skills for the configured runtime revision')
  return bundledSkillNames
}
