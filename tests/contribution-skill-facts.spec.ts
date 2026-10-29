import { createContributionStorage } from '../src/composition/contribution-storage.js'
import { expect, it } from 'vitest'
import { postgresSkillService } from './fixtures/postgres-skill-service.js'
import { PostgresExecutionConfigurations } from '../src/adapters/postgres-execution-configurations.js'
import { ExecutionAdministration } from '../src/use-cases/execution-administration.js'
import { MemberContributions } from '../src/use-cases/member-contributions.js'
import { cleanupOwned } from './fixtures/owned-cleanup.js'

it('keeps the library, contribution and secret configuration unchanged when adoption COMMIT is rejected', async () => {
  const upload = { name: 'guide', description: 'Guide', hash: 'a'.repeat(64), markdown: '# Guide', files: ['SKILL.md'] }
  const fixture = await postgresSkillService({ accept: async () => upload, read: async () => upload, collect: async () => {}, newToken: () => 'review-token' })
  const persistence = createContributionStorage(fixture.database),
    execution = new PostgresExecutionConfigurations(fixture.database)
  let publicationFailure = false,
    factCalls = 0
  const commit = persistence.actions.skill.bind(persistence.actions)
  persistence.actions.skill = async (...args) => {
    factCalls++
    await commit(...args)
    if (publicationFailure) throw Error('publication failed after commit')
  }
  let service: MemberContributions | undefined
  try {
    await execution.initialize()
    let identity = 0
    const administration = new ExecutionAdministration(
      fixture.accounts,
      { get: id => ({ id, version: upload.hash }), owns: async () => true },
      execution,
      async () => {},
    )
    const makeService = () =>
      new MemberContributions(
        fixture.accounts,
        persistence,
        { accept: async () => upload, read: async () => new Uint8Array(), collect: async () => {}, newId: () => 'id-' + ++identity },
        fixture.library,
        { now: () => 1 },
        undefined,
        administration,
        undefined,
        undefined,
      )
    service = makeService()
    async function* bytes() {
      yield new Uint8Array([1])
    }
    const row = await service.submit(
      fixture.member,
      {
        purpose: 'Share',
        execution: { commands: [{ command: 'guide', blocked: [] }], variables: [{ name: 'KEY', purpose: 'Authentication', application: 'Provider console' }] },
      },
      bytes(),
      new AbortController().signal,
    )
    const review = await service.review(fixture.actor, row.id, row.revision)
    const before = await fixture.library.list(fixture.actor)
    await fixture.database.query(`CREATE TABLE dsh_phalanx.reject_adoption_parent(id integer PRIMARY KEY);
      CREATE TABLE dsh_phalanx.reject_adoption_child(id integer REFERENCES dsh_phalanx.reject_adoption_parent DEFERRABLE INITIALLY DEFERRED);
      CREATE FUNCTION dsh_phalanx.reject_adoption() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN INSERT INTO dsh_phalanx.reject_adoption_child VALUES(1); RETURN NULL; END $$;
      CREATE TRIGGER reject_adoption AFTER INSERT ON dsh_phalanx.execution_configurations FOR EACH ROW EXECUTE FUNCTION dsh_phalanx.reject_adoption();`)
    await expect(
      service.decide(fixture.actor, row.id, {
        action: 'adopt',
        revision: row.revision,
        token: review.token,
        setup: {
          execution: {
            enabled: true,
            commands: [{ command: 'guide', blocked: [] }],
            variables: [{ name: 'KEY', value: 'fictional-adoption-key', secret: true }],
          },
        },
      }),
    ).rejects.toMatchObject({ sqlState: '23503' })
    expect(await fixture.library.list(fixture.actor)).toEqual(before)
    expect((await service.list(fixture.actor, true))[0]?.status).toBe('pending')
    expect(await execution.get('skill:guide')).toBeUndefined()
    await fixture.database.query('DROP TRIGGER reject_adoption ON dsh_phalanx.execution_configurations')
    publicationFailure = true
    await expect(
      service.decide(fixture.actor, row.id, {
        action: 'adopt',
        revision: row.revision,
        token: review.token,
        setup: {
          execution: {
            enabled: true,
            commands: [{ command: 'guide', blocked: [] }],
            variables: [{ name: 'KEY', value: 'fictional-adoption-key', secret: true }],
          },
        },
      }),
    ).rejects.toThrow('publication failed after commit')
    expect((await fixture.library.list(fixture.actor)).map(skill => skill.name)).toEqual(['guide'])
    expect((await service.list(fixture.actor, true))[0]?.status).toBe('adopted')
    expect((await execution.get('skill:guide'))?.variables).toEqual([{ name: 'KEY', value: 'fictional-adoption-key', secret: true }])
    const committed = (await execution.get('skill:guide'))!
    await execution.save('skill:guide', { ...committed, variables: [{ name: 'KEY', value: 'fictional-newer-secret', secret: true }] })
    const libraryBeforeRetry = await fixture.storage.library.list(),
      resultBeforeRetry = await persistence.rows.get(row.id)
    await service.stop()
    service = makeService()
    await expect(
      service.decide(fixture.actor, row.id, {
        action: 'adopt',
        revision: row.revision,
        token: 'expired-before-restart',
        setup: { execution: { enabled: true, commands: [], variables: [{ name: 'KEY', value: 'fictional-stale-secret', secret: true }] } },
      }),
    ).resolves.toBeUndefined()
    expect((await execution.get('skill:guide'))?.variables[0]?.value).toBe('fictional-newer-secret')
    expect(factCalls).toBe(2)
    expect(await fixture.storage.library.list()).toEqual(libraryBeforeRetry)
    expect(await persistence.rows.get(row.id)).toEqual(resultBeforeRetry)
  } finally {
    await cleanupOwned(
      async () => service?.stop(),
      () => execution.close(),
      () => fixture.close(),
    )
  }
})
