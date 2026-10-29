import { randomUUID } from 'node:crypto'
import { postgresSkillService } from './postgres-skill-service.js'
import { createContributionStorage } from '../../src/composition/contribution-storage.js'
import { PostgresExecutionConfigurations } from '../../src/adapters/postgres-execution-configurations.js'
import { ExecutionAdministration } from '../../src/use-cases/execution-administration.js'
import { MemberContributions } from '../../src/use-cases/member-contributions.js'
import type { ContributionDeclaration } from '../../src/domain/member-contribution.js'

/** Public controller and actual library use the same PostgreSQL adoption assembly as production. */
export async function postgresContributionService(description = 'Guide') {
  const upload = { name: 'guide', description, hash: 'a'.repeat(64), markdown: '# Guide', files: ['SKILL.md'] },
    fixture = await postgresSkillService({ accept: async () => upload, read: async () => upload, collect: async () => {}, newToken: () => randomUUID() }),
    persistence = createContributionStorage(fixture.database),
    execution = new PostgresExecutionConfigurations(fixture.database)
  try {
    await execution.initialize()
    const administration = new ExecutionAdministration(
        fixture.accounts,
        { get: id => ({ id, version: upload.hash }), owns: async () => true },
        execution,
        async () => {},
      ),
      fault: { beforeConfirm?: () => Promise<void> } = {},
      confirm = fixture.library.confirm.bind(fixture.library)
    fixture.library.confirm = async (...args) => {
      await fault.beforeConfirm?.()
      return confirm(...args)
    }
    const makeService = () =>
      new MemberContributions(
        fixture.accounts,
        persistence,
        { accept: async () => upload, read: async () => new Uint8Array(), collect: async () => {}, newId: () => randomUUID() },
        fixture.library,
        { now: () => 1 },
        undefined,
        administration,
      )
    let service = makeService()
    return {
      ...fixture,
      upload,
      persistence,
      execution,
      administration,
      fault,
      get service() {
        return service
      },
      restart: async () => {
        await service.stop()
        service = makeService()
        await service.recover()
      },
      submit: (declaration: ContributionDeclaration = { purpose: 'Share' }) => {
        async function* bytes() {
          yield new Uint8Array([1])
        }
        return service.submit(fixture.member, declaration, bytes(), new AbortController().signal)
      },
      close: async () => {
        try {
          await service.stop()
        } finally {
          try {
            await execution.close()
          } finally {
            await fixture.close()
          }
        }
      },
    }
  } catch (error) {
    await execution.close()
    await fixture.close()
    throw error
  }
}
