import { createSuiteStorage } from '../src/composition/suite-storage.js'
import { SuiteRetirement } from '../src/use-cases/suite-retirement.js'
import { expect, it } from 'vitest'
import { PostgresExpertRows } from '../src/adapters/postgres-expert-rows.js'
import { postgresSuiteService } from './fixtures/postgres-suite-service.js'

it('previews expert removals and rejects stale confirmation before retiring a public catalog install', async () => {
  const f = await postgresSuiteService(),
    experts = new PostgresExpertRows(f.database)
  try {
    await f.suites.install(f.actor, { id: 'fixture-suite', requestId: 'request-expert-00001', credentials: { SUITE_KEY: 'fictional-suite-key' } })
    await f.settled()
    const definition = {
      name: 'Reader',
      description: 'Reads catalog guides',
      icon: 'R',
      persona: 'Read.',
      examples: [],
      revision: 1,
      published: false,
      skills: ['one'],
      skillPacks: ['fixture-suite'],
      plugins: [],
      mcp: [],
      model: null,
    }
    await experts.save({ ...definition, id: 'reader' })
    const preview = await f.suites.uninstallPreview(f.actor, 'fixture-suite')
    expect(preview).toMatchObject({ experts: [{ id: 'reader', name: 'Reader' }], expertRevision: expect.any(String) })
    const before = await f.storage.library.list()
    await experts.save({ ...definition, id: 'second', name: 'Second reader' })
    await expect(f.suites.uninstall(f.actor, 'fixture-suite', { expertRevision: preview.expertRevision })).rejects.toMatchObject({ code: 'expert-stale' })
    expect(await f.storage.library.list()).toEqual(before)
    const current = await f.suites.uninstallPreview(f.actor, 'fixture-suite')
    await f.suites.uninstall(f.actor, 'fixture-suite', { expertRevision: current.expertRevision })
    await expect.poll(() => f.record()).toBeUndefined()
    expect(await experts.get('reader')).toMatchObject({ revision: 2, skills: [], skillPacks: [] })
    expect(await experts.get('second')).toMatchObject({ revision: 2, skills: [], skillPacks: [] })
  } finally {
    await f.close()
  }
})

it('keeps the public uninstall facts and expert revision intact when the final runtime deletion COMMIT is rejected', async () => {
  const f = await postgresSuiteService(),
    experts = new PostgresExpertRows(f.database)
  try {
    await f.suites.install(f.actor, { id: 'fixture-suite', requestId: 'request-aaaaaaaaaaaa1', credentials: { SUITE_KEY: 'fictional-suite-key' } })
    await f.settled()
    await experts.save({
      id: 'reader',
      name: 'Reader',
      description: 'Reads catalog guides',
      icon: 'R',
      persona: 'Read.',
      examples: [],
      revision: 1,
      published: false,
      skills: ['one'],
      skillPacks: ['fixture-suite'],
      plugins: [],
      mcp: [],
      model: null,
    })
    const before = {
      library: await f.storage.library.list(),
      packs: await f.storage.packs.store.list(),
      execution: await f.runtime.execution.get('skill:one'),
      runtime: await f.runtime.store.list(),
      expert: await experts.get('reader'),
    }
    await f.database.query(`CREATE TABLE dsh_phalanx.reject_retire_parent(id integer PRIMARY KEY);
      CREATE TABLE dsh_phalanx.reject_retire_child(id integer REFERENCES dsh_phalanx.reject_retire_parent DEFERRABLE INITIALLY DEFERRED);
      CREATE FUNCTION dsh_phalanx.reject_retire() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO dsh_phalanx.reject_retire_child VALUES(1); RETURN NULL; END $$;
      CREATE TRIGGER reject_retire AFTER DELETE ON dsh_phalanx.runtime_dependencies FOR EACH ROW EXECUTE FUNCTION dsh_phalanx.reject_retire();`)
    await f.suites
      .uninstall(f.actor, 'fixture-suite', { expertRevision: (await f.suites.uninstallPreview(f.actor, 'fixture-suite')).expertRevision })
      .catch(() => {})
    await f.suites.stop()
    expect.soft(await f.storage.library.list()).toEqual(before.library)
    expect.soft(await f.storage.packs.store.list()).toEqual(before.packs)
    expect.soft(await f.runtime.execution.get('skill:one')).toEqual(before.execution)
    expect.soft(await f.runtime.store.list()).toEqual(before.runtime)
    expect.soft(await experts.get('reader')).toEqual(before.expert)
  } finally {
    await f.close()
  }
})

async function installedFixture() {
  const f = await postgresSuiteService(),
    storage = createSuiteStorage(f.database),
    group = (await f.accounts.listGroups()).find(row => row.kind === 'ordinary')!
  await f.suites.install(f.actor, {
    id: 'fixture-suite',
    requestId: 'request-aaaaaaaaaaaa1',
    publish: true,
    groups: [group.id],
    credentials: { SUITE_KEY: 'fictional-suite-key' },
  })
  await f.settled()
  await f.suites.stop()
  return { f, storage, group, retirement: new SuiteRetirement(storage.work, f.dependencies, { now: () => 2 }) }
}

it('removes every owned fact and retires the receipt in one COMMIT, advancing a shared expert only once', async () => {
  const { f, storage, group, retirement } = await installedFixture(),
    experts = new PostgresExpertRows(f.database)
  try {
    const member = (await f.accounts.list()).find(row => !row.admin)!
    await storage.work.run(async rows => {
      const skill = (await rows.library.list()).find(row => row.name === 'one')!
      await rows.library.save({ ...skill, published: true })
      await rows.grants.set(group.id, ['one'])
      await rows.selections.set(member.spaceId, ['one'])
      await rows.packs.selections.set(member.spaceId, ['fixture-suite'])
      await rows.plugins.save({
        packageName: 'fixture-addon',
        version: '1.0.0',
        stage: 'available',
        published: true,
        suiteOrigin: 'suite:fixture-suite',
        runtimeDependencies: ['suite-cli'],
        current: {
          packageName: 'fixture-addon',
          version: '1.0.0',
          integrity: 'sha512-' + Buffer.alloc(64, 4).toString('base64'),
          artifact: 'artifacts/' + 'd'.repeat(128),
          runtimeRevision: 'fixture',
          title: 'Addon',
          description: '',
          dependencies: {},
          bundlePatch: '- insert:\n  - id: main\n    name: addon\n',
        },
      })
      await rows.pluginAccess.save('fixture-addon', { environment: [{ name: 'ADDON_KEY', value: 'fictional-addon-key' }], entriesYaml: '', entries: {} })
      await rows.pluginGrants.configure(group.id, ['fixture-addon'], [])
      await rows.pluginSelections.set(member.spaceId, ['fixture-addon'])
      const installed = (await rows.installs.get('fixture-suite'))!
      await rows.installs.save({ ...installed.record, entries: [...installed.record.entries, { kind: 'plugin', name: 'fixture-addon' }] }, installed.revision)
    })
    await experts.save({
      id: 'reader',
      name: 'Reader',
      description: 'Reads all suite capabilities',
      icon: 'R',
      persona: 'Read.',
      examples: [],
      revision: 1,
      published: false,
      skills: ['one'],
      skillPacks: ['fixture-suite'],
      plugins: ['fixture-addon'],
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
        'plugin_access_secrets',
        'plugin_grants',
        'plugin_choices',
        'skill_group_grants',
        'pack_group_grants',
        'skill_selections',
        'pack_selections',
        'expert_skills',
        'expert_skill_packs',
        'expert_plugins',
        'experts',
        'catalog_installs',
        'catalog_requests',
      ],
      snapshot = async () =>
        Promise.all(
          tables.map(async table => [table, await f.database.query(`SELECT to_jsonb(t) AS row FROM dsh_phalanx.${table} t ORDER BY to_jsonb(t)::text`)]),
        ),
      before = await snapshot(),
      installed = (await storage.installs.get('fixture-suite'))!
    await f.database.query(`CREATE TABLE dsh_phalanx.reject_remove_parent(id integer PRIMARY KEY);
      CREATE TABLE dsh_phalanx.reject_remove_child(id integer REFERENCES dsh_phalanx.reject_remove_parent DEFERRABLE INITIALLY DEFERRED);
      CREATE FUNCTION dsh_phalanx.reject_remove() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO dsh_phalanx.reject_remove_child VALUES(1); RETURN NULL; END $$;
      CREATE TRIGGER reject_remove AFTER DELETE ON dsh_phalanx.runtime_dependencies FOR EACH ROW EXECUTE FUNCTION dsh_phalanx.reject_remove();`)
    await expect(retirement.remove(f.actor, installed)).rejects.toMatchObject({ sqlState: '23503' })
    expect(await snapshot()).toEqual(before)
    await f.database.query('DROP TRIGGER reject_remove ON dsh_phalanx.runtime_dependencies')
    await retirement.remove(f.actor, installed)
    expect(await storage.installs.get('fixture-suite')).toBeUndefined()
    expect((await storage.requests.get('request-aaaaaaaaaaaa1'))?.result.status).toBe('retired')
    expect(await f.storage.library.list()).toEqual([])
    expect(await f.storage.packs.store.list()).toEqual([])
    expect(await f.runtime.store.list()).toEqual([])
    expect(await f.runtime.execution.get('skill:one')).toBeUndefined()
    expect(await storage.work.run(rows => rows.plugins.list())).toEqual([])
    expect(await storage.work.run(rows => rows.pluginSelections.get(member.spaceId))).toEqual([])
    expect(await f.storage.grants.get(group.id)).toEqual([])
    expect(await f.storage.packs.grants.get(group.id)).toEqual([])
    expect(await experts.get('reader')).toMatchObject({ revision: 2, skills: [], skillPacks: [], plugins: [] })
  } finally {
    await f.close()
  }
})

it('detaches ownership and paired execution atomically while retaining credentials, grants and expert references', async () => {
  const { f, storage, group, retirement } = await installedFixture(),
    experts = new PostgresExpertRows(f.database)
  try {
    await experts.save({
      id: 'reader',
      name: 'Reader',
      description: 'Reads the retained skill',
      icon: 'R',
      persona: 'Read.',
      examples: [],
      revision: 1,
      published: false,
      skills: ['one'],
      skillPacks: [],
      plugins: [],
      mcp: [],
      model: null,
    })
    const installed = (await storage.installs.get('fixture-suite'))!,
      before = {
        library: await f.storage.library.list(),
        execution: await f.runtime.execution.get('skill:one'),
        variables: await f.database.query('SELECT * FROM dsh_phalanx.execution_variables ORDER BY name'),
        expert: await experts.get('reader'),
        grants: await f.storage.packs.grants.get(group.id),
      }
    await f.database.query(`CREATE TABLE dsh_phalanx.reject_detach_parent(id integer PRIMARY KEY);
      CREATE TABLE dsh_phalanx.reject_detach_child(id integer REFERENCES dsh_phalanx.reject_detach_parent DEFERRABLE INITIALLY DEFERRED);
      CREATE FUNCTION dsh_phalanx.reject_detach() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO dsh_phalanx.reject_detach_child VALUES(1); RETURN NULL; END $$;
      CREATE TRIGGER reject_detach AFTER UPDATE ON dsh_phalanx.catalog_installs FOR EACH ROW EXECUTE FUNCTION dsh_phalanx.reject_detach();`)
    await expect(retirement.detach(f.actor, installed, { kind: 'skill', name: 'one' })).rejects.toMatchObject({ sqlState: '23503' })
    expect(await f.storage.library.list()).toEqual(before.library)
    expect(await f.runtime.execution.get('skill:one')).toEqual(before.execution)
    expect(await storage.installs.get('fixture-suite')).toEqual(installed)
    await f.database.query('DROP TRIGGER reject_detach ON dsh_phalanx.catalog_installs')
    await retirement.detach(f.actor, installed, { kind: 'skill', name: 'one' })
    expect((await f.storage.library.list()).find(row => row.name === 'one')?.suiteOrigin).toBeUndefined()
    expect((await f.runtime.execution.get('skill:one'))?.suiteOrigin).toBeUndefined()
    expect((await f.runtime.execution.get('skill:one'))?.variables).toEqual(before.execution?.variables)
    expect(await f.database.query('SELECT * FROM dsh_phalanx.execution_variables ORDER BY name')).toEqual(before.variables)
    expect(await experts.get('reader')).toEqual(before.expert)
    expect(await f.storage.packs.grants.get(group.id)).toEqual(before.grants)
    expect((await storage.installs.get('fixture-suite'))?.record.detached).toEqual([
      { kind: 'skill', name: 'one' },
      { kind: 'execution', name: 'one' },
    ])
    const current = (await storage.installs.get('fixture-suite'))!
    await retirement.detach(f.actor, current, { kind: 'runtime-dependency', name: 'suite-cli' })
    await retirement.remove(f.actor, (await storage.installs.get('fixture-suite'))!)
    expect((await f.storage.library.list()).map(row => row.name)).toEqual(['one'])
    expect(await f.runtime.execution.get('skill:one')).toMatchObject({ variables: before.execution!.variables })
    expect(await experts.get('reader')).toEqual(before.expert)
    expect((await f.runtime.store.list())[0]?.source).toBe('manual')
  } finally {
    await f.close()
  }
})

it('blocks uninstall before deleting a source skill still used by detached manual execution', async () => {
  const { f, storage, retirement } = await installedFixture()
  try {
    await retirement.detach(f.actor, (await storage.installs.get('fixture-suite'))!, { kind: 'execution', name: 'one' })
    const installed = (await storage.installs.get('fixture-suite'))!,
      before = { library: await f.storage.library.list(), execution: await f.runtime.execution.get('skill:one'), runtime: await f.runtime.store.list() }
    await expect(retirement.remove(f.actor, installed)).rejects.toMatchObject({ code: 'runtime-dependency-referenced' })
    expect(await f.storage.library.list()).toEqual(before.library)
    expect(await f.runtime.execution.get('skill:one')).toEqual(before.execution)
    expect(await f.runtime.store.list()).toEqual(before.runtime)
    expect(await storage.installs.get('fixture-suite')).toEqual(installed)
  } finally {
    await f.close()
  }
})
