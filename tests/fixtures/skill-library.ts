import { SkillLibrary as Library } from '../../src/use-cases/skill-library.js'
import type { SkillAssignmentsPort } from '../../src/ports/member-skills.js'

/** Unit fixtures delegate to their supplied repositories. Atomicity and foreign keys are tested against PostgreSQL. */
export class SkillLibrary extends Library {
  constructor(...args: ConstructorParameters<typeof Library>) {
    const empty: SkillAssignmentsPort = { get: async () => [], set: async () => {}, retain: async () => {} }
    args[8] ??= {
      run: operation =>
        operation({
          library: args[1],
          packs: args[7] ?? { store: { list: async () => [], save: async () => {}, remove: async () => {} }, grants: empty, selections: empty },
          grants: empty,
          selections: empty,
        }),
    }
    super(...args)
  }
}
