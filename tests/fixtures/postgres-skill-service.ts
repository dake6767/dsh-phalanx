import { PostgresExpertReferences } from '../../src/adapters/postgres-expert-references.js'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openTestDatabase } from '../support/community-application.js'
import { createSkillStorage } from '../../src/composition/skill-storage.js'
import { PostgresCommunityAccountStore } from '../../src/adapters/postgres-community-accounts.js'
import { SkillLibrary } from '../../src/use-cases/skill-library.js'
import { SkillPacks } from '../../src/use-cases/skill-packs.js'
import { SkillMembership } from '../../src/use-cases/skill-membership.js'
import { MemberEffectiveSkills } from '../../src/use-cases/member-effective-skills.js'
import type { SkillArtifactsPort } from '../../src/ports/skill-library.js'
import type { SkillUnitOfWork } from '../../src/ports/skill-unit-of-work.js'

/** Business operations use the same transaction and committed-view assembly as production. */
export async function postgresSkillService(artifacts?: SkillArtifactsPort) {
  const root = await mkdtemp(join(tmpdir(), 'skill-service-'))
  try {
    const database = await openTestDatabase(root)
    const storage = createSkillStorage(database)
    try {
      const accounts = new PostgresCommunityAccountStore(database)
      const actor = await accounts.createFirstAdmin({ username: 'admin', email: '', password: 'password' })
      const member = await accounts.create({ username: 'member', email: '', password: 'password' })
      await storage.initialize()
      const fault: { commit?: boolean; projection?: boolean } = {}
      const work: SkillUnitOfWork = {
        run: operation =>
          storage.work.run(async repositories => {
            const result = await operation(repositories)
            if (fault.commit) {
              fault.commit = false
              throw Error('commit failed')
            }
            return result
          }),
      }
      const files: SkillArtifactsPort = artifacts ?? {
        accept: async () => {
          throw Error('unused')
        },
        read: async () => ({ markdown: '', files: [] }),
        collect: async () => {},
        newToken: () => 'token',
        createNote: async (name, description, markdown) => ({ name, description, markdown, files: ['SKILL.md'], hash: 'a'.repeat(64) }),
      }
      const effective = new MemberEffectiveSkills(accounts, storage.library.view, storage.grants.view, storage.selections.view, {
        store: storage.packs.store.view,
        grants: storage.packs.grants.view,
        selections: storage.packs.selections.view,
      })
      const membership = new SkillMembership(
        accounts,
        storage.library,
        storage.grants,
        storage.selections,
        effective,
        {
          synchronize: async () => {
            if (fault.projection) {
              fault.projection = false
              throw Error('projection failed')
            }
          },
        },
        undefined,
        storage.packs,
        operation => library.transaction(operation),
      )
      const library: SkillLibrary = new SkillLibrary(
        accounts,
        storage.library,
        files,
        { now: () => 1 },
        membership,
        undefined,
        [],
        storage.packs,
        work,
        undefined,
        undefined,
        new PostgresExpertReferences(database),
      )
      const packs = new SkillPacks(
        accounts,
        storage.library,
        storage.packs,
        storage.grants,
        library,
        {
          createNote: (name, description, instructions) => files.createNote!(name, description, instructions),
        },
        { now: () => 1 },
        [],
        storage.selections,
      )
      return {
        root,
        database,
        accounts,
        actor,
        member,
        storage,
        library,
        packs,
        fault,
        close: async () => {
          try {
            try {
              await library.stop()
            } finally {
              await storage.close()
            }
          } finally {
            try {
              await database.close()
            } finally {
              await rm(root, { recursive: true, force: true })
            }
          }
        },
      }
    } catch (error) {
      try {
        await storage.close()
      } finally {
        await database.close()
      }
      throw error
    }
  } catch (error) {
    await rm(root, { recursive: true, force: true })
    throw error
  }
}
