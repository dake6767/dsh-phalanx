import { runtimeVersion } from './fixtures/runtime-version.js'
import { SuiteTransactions } from '../src/use-cases/suite-transactions.js'
import { createSuiteStorage } from '../src/composition/suite-storage.js'
import { suiteRuntimeDependencyDefinition } from '../src/domain/suite-catalog.js'
import { createHash } from 'node:crypto'
import { expect, it } from 'vitest'
import { postgresSuiteService, suiteVersion } from './fixtures/postgres-suite-service.js'
import { PostgresExpertRows } from '../src/adapters/postgres-expert-rows.js'

it.each(['install', 'update', 'uninstall'] as const)('continues an accepted %s task when its progress publisher rejects after COMMIT', async operation => {
  const f = await postgresSuiteService()
  try {
    if (operation !== 'install') {
      await f.suites.install(f.actor, { id: 'fixture-suite', requestId: 'request-progress-0001', credentials: { SUITE_KEY: 'fictional-suite-key' } })
      await f.settled()
    }
    const unsubscribe = f.database.subscribeCommittedWrites(['dsh_phalanx.catalog_installs'], async () => {
      unsubscribe()
      throw Error('accepted progress publisher unavailable')
    })
    if (operation === 'install')
      await expect(
        f.suites.install(f.actor, { id: 'fixture-suite', requestId: 'request-progress-0001', credentials: { SUITE_KEY: 'fictional-suite-key' } }),
      ).resolves.toMatchObject({ status: 'installing' })
    else if (operation === 'update') {
      f.upgrade(suiteVersion(2))
      await expect(f.suites.update(f.actor, 'fixture-suite')).resolves.toMatchObject({ status: 'updating' })
    } else await expect(f.suites.uninstall(f.actor, 'fixture-suite')).resolves.toBeUndefined()
    if (operation === 'uninstall') await expect.poll(() => f.record()).toBeUndefined()
    else await f.settled()
    await f.suites.stop()
    if (operation === 'uninstall') {
      expect(await f.record()).toBeUndefined()
      expect(await f.storage.library.list()).toEqual([])
    } else {
      expect(await f.record()).toMatchObject({ status: 'installed', version: operation === 'update' ? '2' : '1' })
      expect((await f.storage.library.list()).map(row => row.name)).toEqual(operation === 'update' ? ['one', 'two'] : ['obsolete', 'one'])
    }
  } finally {
    await f.close()
  }
})

it('keeps every installed catalog fact and expert reference unchanged when a later execution COMMIT is rejected', async () => {
  const f = await postgresSuiteService(),
    experts = new PostgresExpertRows(f.database)
  let release!: () => void, entered!: () => void, holder: Promise<void> | undefined
  const gate = new Promise<void>(resolve => {
      release = resolve
    }),
    began = new Promise<void>(resolve => {
      entered = resolve
    })
  try {
    const group = (await f.accounts.listGroups()).find(row => row.kind === 'ordinary')!
    await f.suites.install(f.actor, {
      id: 'fixture-suite',
      requestId: 'request-aaaaaaaaaaaa1',
      groups: [group.id],
      publish: true,
      credentials: { SUITE_KEY: 'fictional-suite-key' },
    })
    await f.settled()
    expect((await f.record())?.version).toBe('1')
    await experts.save({
      id: 'reader',
      name: 'Reader',
      description: 'Reads the installed obsolete guide',
      icon: 'R',
      persona: 'Read.',
      examples: [],
      revision: 1,
      published: false,
      skills: ['obsolete'],
      skillPacks: [],
      plugins: [],
      mcp: [],
      model: null,
    })
    const before = {
      library: await f.storage.library.list(),
      packs: await f.storage.packs.store.list(),
      runtime: await f.runtime.store.list(),
      execution: await f.runtime.execution.get('skill:one'),
      expert: await experts.get('reader'),
      grants: await f.storage.packs.grants.get(group.id),
    }
    await f.database.query(`CREATE TABLE dsh_phalanx.reject_suite_parent(id integer PRIMARY KEY);
      CREATE TABLE dsh_phalanx.reject_suite_child(id integer REFERENCES dsh_phalanx.reject_suite_parent DEFERRABLE INITIALLY DEFERRED);
      CREATE FUNCTION dsh_phalanx.reject_suite() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(hashtext('dsh_phalanx.test.catalog.commit-gate')); INSERT INTO dsh_phalanx.reject_suite_child VALUES(1); RETURN NULL; END $$;
      CREATE TRIGGER reject_suite AFTER UPDATE ON dsh_phalanx.execution_configurations FOR EACH ROW
        WHEN (NEW.configuration::text LIKE '%new-block%') EXECUTE FUNCTION dsh_phalanx.reject_suite();`)
    holder = f.database.transaction(async sql => {
      await sql.query("SELECT pg_advisory_xact_lock(hashtext('dsh_phalanx.test.catalog.commit-gate'))")
      entered()
      await gate
    })
    await began
    f.upgrade(suiteVersion(2))
    await f.suites.update(f.actor, 'fixture-suite')
    await expect
      .poll(async () =>
        Number(
          (
            await f.database.query<{ waiting: string }>(
              "SELECT count(*) AS waiting FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'",
            )
          )[0]!.waiting,
        ),
      )
      .toBeGreaterThan(0)
    // Another connection may observe the old complete catalog, never the middle of its switch.
    expect.soft(await f.storage.library.list()).toEqual(before.library)
    expect.soft(await f.runtime.store.list()).toEqual(before.runtime)
    release()
    await holder
    await f.settled()
    expect((await f.record())?.version).toBe('1')
    expect((await f.record())?.failureCode).toBeDefined()
    expect(await f.storage.library.list()).toEqual(before.library)
    expect(await f.storage.packs.store.list()).toEqual(before.packs)
    expect(await f.runtime.store.list()).toEqual(before.runtime)
    expect(await f.runtime.execution.get('skill:one')).toEqual(before.execution)
    expect(await experts.get('reader')).toEqual(before.expert)
    expect(await f.storage.packs.grants.get(group.id)).toEqual(before.grants)
  } finally {
    release()
    await Promise.allSettled(holder ? [holder] : [])
    await f.close()
  }
})

it('switches a prepared suite update in one transaction and rolls back the final deferred rejection', async () => {
  const f = await postgresSuiteService(),
    storage = createSuiteStorage(f.database),
    experts = new PostgresExpertRows(f.database)
  let release!: () => void, entered!: () => void, holder: Promise<void> | undefined
  const gate = new Promise<void>(resolve => {
      release = resolve
    }),
    began = new Promise<void>(resolve => {
      entered = resolve
    })
  try {
    await f.suites.install(f.actor, { id: 'fixture-suite', requestId: 'request-aaaaaaaaaaaa1', credentials: { SUITE_KEY: 'fictional-suite-key' } })
    await f.settled()
    await experts.save({
      id: 'reader',
      name: 'Reader',
      description: 'Reads obsolete guide',
      icon: 'R',
      persona: 'Read.',
      examples: [],
      revision: 1,
      published: false,
      skills: ['obsolete'],
      skillPacks: [],
      plugins: [],
      mcp: [],
      model: null,
    })
    const before = {
      library: await f.storage.library.list(),
      packs: await f.storage.packs.store.list(),
      runtime: await f.runtime.store.list(),
      execution: await f.runtime.execution.get('skill:one'),
      expert: await experts.get('reader'),
      record: await storage.installs.get('fixture-suite'),
    }
    const entry = suiteVersion(2),
      runtime = entry.items.find(item => item.kind === 'runtime-dependency')!,
      skill = entry.items.find(item => item.kind === 'skill')!,
      definition = suiteRuntimeDependencyDefinition(runtime, 'amd64')!,
      version = await f.dependencies.stageManaged(definition),
      plan = {
        installed: before.record!,
        entry,
        runtime: [{ definition, version }],
        skills: [
          {
            item: skill,
            rows: skill.names.map(name => ({
              name,
              description: name,
              hash: createHash('sha256')
                .update(name + skill.source.commit)
                .digest('hex'),
              importedAt: 2,
              published: false,
              suiteOrigin: 'suite:fixture-suite',
            })),
          },
        ],
      }
    const unit = new SuiteTransactions(storage.work, f.dependencies, { now: () => 2 })
    await f.database.query(`CREATE TABLE dsh_phalanx.reject_update_parent(id integer PRIMARY KEY);
      CREATE TABLE dsh_phalanx.reject_update_child(id integer REFERENCES dsh_phalanx.reject_update_parent DEFERRABLE INITIALLY DEFERRED);
      CREATE FUNCTION dsh_phalanx.reject_update() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(hashtext('dsh_phalanx.test.update.commit-gate')); INSERT INTO dsh_phalanx.reject_update_child VALUES(1); RETURN NULL; END $$;
      CREATE TRIGGER reject_update AFTER UPDATE ON dsh_phalanx.execution_configurations FOR EACH ROW
        WHEN (NEW.configuration::text LIKE '%new-block%') EXECUTE FUNCTION dsh_phalanx.reject_update();`)
    holder = f.database.transaction(async sql => {
      await sql.query("SELECT pg_advisory_xact_lock(hashtext('dsh_phalanx.test.update.commit-gate'))")
      entered()
      await gate
    })
    await began
    const operation = unit.update(f.actor, plan).then(
      () => undefined,
      error => error,
    )
    await expect
      .poll(async () =>
        Number(
          (
            await f.database.query<{ waiting: string }>(
              "SELECT count(*) AS waiting FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'",
            )
          )[0]!.waiting,
        ),
      )
      .toBeGreaterThan(0)
    expect.soft(await f.storage.library.list()).toEqual(before.library)
    expect.soft(await f.runtime.store.list()).toEqual(before.runtime)
    release()
    await holder
    expect(await operation).toMatchObject({ sqlState: '23503' })
    expect(await f.storage.library.list()).toEqual(before.library)
    expect(await f.storage.packs.store.list()).toEqual(before.packs)
    expect(await f.runtime.store.list()).toEqual(before.runtime)
    expect(await f.runtime.execution.get('skill:one')).toEqual(before.execution)
    expect(await experts.get('reader')).toEqual(before.expert)
    expect(await storage.installs.get('fixture-suite')).toEqual(before.record)
    await f.database.query('DROP TRIGGER reject_update ON dsh_phalanx.execution_configurations')
    await unit.update(f.actor, plan)
    expect((await storage.installs.get('fixture-suite'))?.record).toMatchObject({ status: 'installed', version: '2' })
    expect((await f.storage.library.list()).map(row => row.name)).toEqual(['one', 'two'])
    expect(await experts.get('reader')).toMatchObject({ skills: [], revision: 2 })
    expect((await f.runtime.store.list())[0]).toMatchObject({ current: version, previous: before.runtime[0]!.current })
    expect((await f.runtime.execution.get('skill:one'))?.variables).toEqual(before.execution?.variables)
    await expect(unit.update(f.actor, plan)).rejects.toMatchObject({ code: 'suite-task-running' })
  } finally {
    release()
    await Promise.allSettled(holder ? [holder] : [])
    await f.close()
  }
})

it.each(['runtime', 'execution'] as const)('rejects a %s definition advanced while the update waits for its command locks', async kind => {
  const f = await postgresSuiteService(),
    storage = createSuiteStorage(f.database)
  let release!: () => void, entered!: () => void, holder: Promise<void> | undefined
  const gate = new Promise<void>(resolve => {
      release = resolve
    }),
    began = new Promise<void>(resolve => {
      entered = resolve
    })
  try {
    await f.suites.install(f.actor, { id: 'fixture-suite', requestId: 'request-aaaaaaaaaaaa1', credentials: { SUITE_KEY: 'fictional-suite-key' } })
    await f.settled()
    const installed = (await storage.installs.get('fixture-suite'))!,
      entry = suiteVersion(2),
      runtime = entry.items.find(item => item.kind === 'runtime-dependency')!,
      skill = entry.items.find(item => item.kind === 'skill')!,
      definition = suiteRuntimeDependencyDefinition(runtime, 'amd64')!,
      originalVersion = await f.dependencies.stageManaged(definition),
      version = { ...originalVersion, commands: ['aaa-future'], commandPaths: { 'aaa-future': 'bin/future' } },
      plan = {
        installed,
        entry,
        runtime: [{ definition, version }],
        skills: [
          {
            item: skill,
            rows: skill.names.map(name => ({
              name,
              description: name,
              hash: createHash('sha256')
                .update(name + skill.source.commit)
                .digest('hex'),
              importedAt: 2,
              published: false,
              suiteOrigin: 'suite:fixture-suite',
            })),
          },
        ],
      },
      before = await f.storage.library.list()
    holder = f.database.transaction(async sql => {
      await sql.query("SELECT pg_advisory_xact_lock(hashtextextended('dsh_phalanx.runtime.command:' || $1,0))", ['aaa-future'])
      entered()
      await gate
    })
    await began
    const operation = new SuiteTransactions(storage.work, f.dependencies, { now: () => 2 }).update(f.actor, plan).then(
      () => undefined,
      error => error,
    )
    await expect
      .poll(async () =>
        Number(
          (
            await f.database.query<{ waiting: string }>(
              "SELECT count(*) AS waiting FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'",
            )
          )[0]!.waiting,
        ),
      )
      .toBeGreaterThan(0)
    if (kind === 'runtime') {
      const row = (await f.runtime.store.list())[0]!
      await f.runtime.store.save({ ...row, log: 'New administrator runtime definition.' })
    } else {
      const row = (await f.runtime.execution.get('skill:one'))!
      await f.runtime.execution.save('skill:one', { ...row, commands: [{ command: 'suite-cli', blocked: ['new-administrator-rule'] }] })
    }
    const runtimeAfterWriter = await f.runtime.store.list(),
      executionAfterWriter = await f.runtime.execution.get('skill:one')
    release()
    await holder
    expect(await operation).toMatchObject({ code: 'suite-task-running' })
    expect(await f.storage.library.list()).toEqual(before)
    expect(await f.runtime.store.list()).toEqual(runtimeAfterWriter)
    expect(await f.runtime.execution.get('skill:one')).toEqual(executionAfterWriter)
    expect(await storage.installs.get('fixture-suite')).toEqual(installed)
  } finally {
    release()
    await Promise.allSettled(holder ? [holder] : [])
    await f.close()
  }
})

it('refuses a prepared skill stage that still includes an already detached skill', async () => {
  const f = await postgresSuiteService(),
    storage = createSuiteStorage(f.database)
  try {
    await f.suites.install(f.actor, { id: 'fixture-suite', requestId: 'request-aaaaaaaaaaaa1', credentials: { SUITE_KEY: 'fictional-suite-key' } })
    await f.settled()
    const entry = suiteVersion(2),
      skill = entry.items.find(item => item.kind === 'skill')!,
      prepared = skill.names.map(name => ({
        name,
        description: name,
        hash: createHash('sha256').update(name).digest('hex'),
        importedAt: 2,
        published: false,
        suiteOrigin: 'suite:fixture-suite',
      }))
    await f.suites.detach(f.actor, 'fixture-suite', { kind: 'skill', name: 'one' })
    const installed = (await storage.installs.get('fixture-suite'))!,
      before = await f.storage.library.list(),
      execution = await f.runtime.execution.get('skill:one')
    await expect(
      new SuiteTransactions(storage.work, f.dependencies, { now: () => 2 }).update(f.actor, {
        installed,
        entry,
        runtime: [],
        skills: [{ item: skill, rows: prepared }],
      }),
    ).rejects.toMatchObject({ code: 'suite-task-running' })
    expect(await f.storage.library.list()).toEqual(before)
    expect(await f.runtime.execution.get('skill:one')).toEqual(execution)
    expect(await storage.installs.get('fixture-suite')).toEqual(installed)
  } finally {
    await f.close()
  }
})

it('updates the actual name retained by a manual dependency takeover', async () => {
  const f = await postgresSuiteService(),
    storage = createSuiteStorage(f.database)
  try {
    await f.runtime.store.save({
      name: 'manual-cli',
      source: 'manual',
      prepareCommand: 'manual-cli',
      pathDirectories: ['bin'],
      stage: 'ready',
      checks: [],
      log: '',
      updatedAt: 0,
      current: { ...runtimeVersion('a'), commands: ['suite-cli'], commandPaths: { 'suite-cli': 'bin/suite-cli' } },
    })
    await f.suites.install(f.actor, {
      id: 'fixture-suite',
      requestId: 'request-aaaaaaaaaaaa1',
      credentials: { SUITE_KEY: 'fictional-suite-key' },
      replace: (await f.suites.installPreview(f.actor, 'fixture-suite')).replacements,
    })
    await f.settled()
    expect((await f.record())?.dependencyNames).toEqual({ 'suite-cli': 'manual-cli' })
    const installed = (await storage.installs.get('fixture-suite'))!,
      entry = suiteVersion(2),
      tool = entry.items.find(item => item.kind === 'runtime-dependency')!,
      item = entry.items.find(item => item.kind === 'skill')!,
      definition = suiteRuntimeDependencyDefinition(tool, 'amd64')!,
      version = await f.dependencies.stageManaged(definition)
    await new SuiteTransactions(storage.work, f.dependencies, { now: () => 2 }).update(f.actor, {
      installed,
      entry,
      runtime: [{ definition, version }],
      skills: [
        {
          item,
          rows: item.names.map(name => ({
            name,
            description: name,
            hash: createHash('sha256').update(name).digest('hex'),
            importedAt: 2,
            published: false,
            suiteOrigin: 'suite:fixture-suite',
          })),
        },
      ],
    })
    expect((await f.runtime.store.list()).map(row => row.name)).toEqual(['manual-cli'])
    expect((await f.runtime.store.list())[0]?.current).toEqual(version)
    expect((await f.runtime.execution.get('skill:one'))?.runtimeDependencies).toEqual(['manual-cli'])
    expect((await storage.installs.get('fixture-suite'))?.record.entries).toContainEqual({ kind: 'runtime-dependency', name: 'manual-cli' })
  } finally {
    await f.close()
  }
})
