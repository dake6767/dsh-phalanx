import { expect, it } from 'vitest'
import { createSuiteStorage } from '../src/composition/suite-storage.js'
import { PostgresExpertRows } from '../src/adapters/postgres-expert-rows.js'
import { postgresSuiteService } from './fixtures/postgres-suite-service.js'

it('binds catalog, capability, secret, grant and expert retirement facts to the same rejected COMMIT', async () => {
  const f = await postgresSuiteService(),
    storage = createSuiteStorage(f.database),
    experts = new PostgresExpertRows(f.database)
  try {
    await f.suites.install(f.actor, { id: 'fixture-suite', requestId: 'request-aaaaaaaaaaaa1', credentials: { SUITE_KEY: 'fictional-suite-key' } })
    await f.settled()
    await experts.save({
      id: 'reader',
      name: 'Reader',
      description: 'Reads the installed guide',
      icon: 'R',
      persona: 'Read.',
      examples: [],
      revision: 1,
      published: false,
      skills: ['obsolete'],
      skillPacks: ['fixture-suite'],
      plugins: [],
      mcp: [],
      model: null,
    })
    const tables = [
      'skills',
      'skill_packs',
      'runtime_dependencies',
      'execution_configurations',
      'execution_variables',
      'plugin_library',
      'plugin_access_settings',
      'plugin_upstreams',
      'catalog_installs',
      'catalog_requests',
      'experts',
    ]
    // Compare actual persisted rows, including nonces and protected envelopes, rather than only public projections.
    const snapshot = async () =>
      Promise.all(
        tables.map(async table => [table, await f.database.query(`SELECT to_jsonb(t) AS row FROM dsh_phalanx.${table} t ORDER BY to_jsonb(t)::text`)]),
      )
    const before = await snapshot(),
      group = (await f.accounts.listGroups()).find(row => row.kind === 'ordinary')!
    const commit = () =>
      storage.work.run(async rows => {
        await rows.requests.lockLedger()
        await rows.accounts.lock(f.actor, f.actor, [group.id])
        const runtime = (await rows.runtime.list())[0]!
        await rows.runtime.save({ ...runtime, log: 'Updated in one transaction.' })
        const one = (await rows.library.list()).find(row => row.name === 'one')!
        await rows.library.save({ ...one, description: 'New description.' })
        const pack = (await rows.packs.store.list())[0]!
        await rows.packs.store.save({ ...pack, description: 'New pack.' })
        await rows.packs.grants.set(group.id, [pack.name])
        const execution = (await rows.execution.get('skill:one'))!
        await rows.execution.save('skill:one', { ...execution, variables: [{ name: 'SUITE_KEY', secret: true, value: 'fictional-next-key' }] })
        await rows.plugins.save({ packageName: 'catalog-plugin', version: '1.0.0', stage: 'failed', current: null, published: false })
        await rows.pluginAccess.save('catalog-plugin', { environment: [{ name: 'KEY', value: 'fictional-access-key' }], entriesYaml: '', entries: {} })
        await rows.pluginUpstreams.save('catalog-plugin', [
          { name: 'provider', baseUrl: 'https://provider.example', credential: 'fictional-upstream-key', headers: [] },
        ])
        await rows.pluginGrants.configure(group.id, ['catalog-plugin'], [])
        await rows.expertReferences.detach([{ kind: 'skill', name: 'obsolete' }])
        const obsolete = (await rows.library.list()).find(row => row.name === 'obsolete')!
        await rows.library.remove(obsolete.name, obsolete.rowRevision)
        const installed = (await rows.installs.get('fixture-suite'))!
        await rows.installs.save(
          {
            id: 'fixture-suite',
            version: '2',
            status: 'installed',
            entries: [{ kind: 'skill', name: 'one' }],
            updatedAt: 2,
            log: 'Installed.',
          },
          installed.revision,
        )
        await rows.requests.save('request-transaction', { id: 'fixture-suite', version: '2', status: 'complete' })
      })
    await f.database.query(`CREATE TABLE dsh_phalanx.reject_bound_parent(id integer PRIMARY KEY);
      CREATE TABLE dsh_phalanx.reject_bound_child(id integer REFERENCES dsh_phalanx.reject_bound_parent DEFERRABLE INITIALLY DEFERRED);
      CREATE FUNCTION dsh_phalanx.reject_bound() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO dsh_phalanx.reject_bound_child VALUES(1); RETURN NULL; END $$;
      CREATE TRIGGER reject_bound AFTER UPDATE ON dsh_phalanx.catalog_installs FOR EACH ROW EXECUTE FUNCTION dsh_phalanx.reject_bound();`)
    await expect(commit()).rejects.toMatchObject({ sqlState: '23503' })
    expect(await snapshot()).toEqual(before)
    expect(await f.storage.packs.grants.get(group.id)).toEqual([])
    expect(await experts.get('reader')).toMatchObject({ revision: 1, skills: ['obsolete'] })
    await f.database.query('DROP TRIGGER reject_bound ON dsh_phalanx.catalog_installs')
    await commit()
    expect((await storage.installs.get('fixture-suite'))?.record.version).toBe('2')
    expect((await storage.requests.get('request-transaction'))?.result.status).toBe('complete')
    expect(await experts.get('reader')).toMatchObject({ revision: 2, skills: [], skillPacks: ['fixture-suite'] })
    expect(await f.storage.packs.grants.get(group.id)).toEqual(['fixture-suite'])
  } finally {
    await f.close()
  }
})
