import { createHash } from 'node:crypto'
import { expect, it } from 'vitest'
import { SuiteTransactions } from '../src/use-cases/suite-transactions.js'
import { createSuiteStorage } from '../src/composition/suite-storage.js'
import { suiteRuntimeDependencyDefinition } from '../src/domain/suite-catalog.js'
import { postgresSuiteService, suiteVersion } from './fixtures/postgres-suite-service.js'

async function pendingPreparedInstall(
  f: Awaited<ReturnType<typeof postgresSuiteService>>,
  storage: ReturnType<typeof createSuiteStorage>,
  entry = suiteVersion(1),
) {
  const tool = entry.items.find(item => item.kind === 'runtime-dependency'),
    skill = entry.items.find(item => item.kind === 'skill')!,
    pack = entry.items.find(item => item.kind === 'skill-pack')!,
    definition = tool ? suiteRuntimeDependencyDefinition(tool, 'amd64')! : undefined,
    version = definition ? await f.dependencies.stageManaged(definition) : undefined,
    group = (await f.accounts.listGroups()).find(row => row.kind === 'ordinary')!,
    options = {
      id: entry.id,
      requestId: 'request-transaction-install',
      publish: true,
      groups: [group.id],
      credentials: entry.items.some(item => item.kind === 'execution') ? { SUITE_KEY: 'fictional-suite-key' } : {},
    }
  await storage.installs.save({
    id: entry.id,
    version: entry.version,
    category: entry.category,
    status: 'installing',
    entries: [],
    requestId: options.requestId,
    dependencies: entry.dependencies,
    updatedAt: 1,
    log: 'Installing.',
  })
  await storage.requests.save(options.requestId, { id: entry.id, version: entry.version, status: 'pending' })
  const installed = (await storage.installs.get(entry.id))!,
    request = (await storage.requests.get(options.requestId))!,
    units = [
      {
        installed,
        entry,
        runtime: definition && version ? [{ definition, version }] : [],
        skills: [
          {
            item: skill,
            rows: skill.names.map(name => ({
              name,
              description: name,
              hash: createHash('sha256')
                .update(name + skill.source.commit)
                .digest('hex'),
              importedAt: 1,
              published: false,
              suiteOrigin: 'suite:' + entry.id,
            })),
          },
        ],
        note: { name: pack.name, description: pack.description, hash: createHash('sha256').update(pack.note).digest('hex'), importedAt: 1, published: false },
      },
    ]
  return { entry, group, pack, options, installed, request, units, service: new SuiteTransactions(storage.work, f.dependencies, { now: () => 2 }) }
}

it('commits a prepared install, wizard distribution, credentials and its deduplication result together', async () => {
  const f = await postgresSuiteService(),
    storage = createSuiteStorage(f.database)
  try {
    const { entry, group, pack, options, installed, request, units, service } = await pendingPreparedInstall(f, storage)
    await f.database.query(`CREATE TABLE dsh_phalanx.reject_install_parent(id integer PRIMARY KEY);
      CREATE TABLE dsh_phalanx.reject_install_child(id integer REFERENCES dsh_phalanx.reject_install_parent DEFERRABLE INITIALLY DEFERRED);
      CREATE FUNCTION dsh_phalanx.reject_install() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO dsh_phalanx.reject_install_child VALUES(1); RETURN NULL; END $$;
      CREATE TRIGGER reject_install AFTER UPDATE ON dsh_phalanx.catalog_installs FOR EACH ROW WHEN (NEW.state='installed') EXECUTE FUNCTION dsh_phalanx.reject_install();`)
    await expect(service.install(f.actor, units, options, request)).rejects.toMatchObject({ sqlState: '23503' })
    expect(await f.storage.library.list()).toEqual([])
    expect(await f.storage.packs.store.list()).toEqual([])
    expect(await f.storage.packs.grants.get(group.id)).toEqual([])
    expect(await f.runtime.store.list()).toEqual([])
    expect(await f.runtime.execution.get('skill:one')).toBeUndefined()
    expect(await storage.installs.get(entry.id)).toEqual(installed)
    expect(await storage.requests.get(options.requestId)).toEqual(request)
    await f.database.query('DROP TRIGGER reject_install ON dsh_phalanx.catalog_installs')
    await service.install(f.actor, units, options, request)
    expect((await storage.installs.get(entry.id))?.record).toMatchObject({ status: 'installed', version: '1' })
    expect((await storage.requests.get(options.requestId))?.result).toEqual({ id: entry.id, version: '1', status: 'complete' })
    expect((await f.storage.packs.store.list())[0]?.published).toBe(true)
    expect(await f.storage.packs.grants.get(group.id)).toEqual([pack.name])
    expect((await f.runtime.execution.get('skill:one'))?.variables).toEqual([{ name: 'SUITE_KEY', value: 'fictional-suite-key', secret: true }])
    const beforeReplay = {
      library: await f.storage.library.list(),
      runtime: await f.runtime.store.list(),
      record: await storage.installs.get(entry.id),
      request: await storage.requests.get(options.requestId),
    }
    await service.install(f.actor, units, options, request)
    expect({
      library: await f.storage.library.list(),
      runtime: await f.runtime.store.list(),
      record: await storage.installs.get(entry.id),
      request: await storage.requests.get(options.requestId),
    }).toEqual(beforeReplay)
  } finally {
    await f.close()
  }
})

it('does not overwrite a competing pack after a catalog plan expected no pack row', async () => {
  const f = await postgresSuiteService(),
    storage = createSuiteStorage(f.database)
  try {
    await f.storage.packs.store.save({ name: 'fixture-suite', description: 'Manual pack', skills: [], instructions: 'Manual instructions', published: true })
    const before = await f.storage.packs.store.list()
    await expect(
      storage.work.run(rows =>
        rows.packs.store.save(
          { name: 'fixture-suite', description: 'Catalog pack', skills: [], instructions: '', published: false, suiteOrigin: 'suite:fixture-suite' },
          'none',
        ),
      ),
    ).rejects.toMatchObject({ code: 'skill-preview-changed' })
    expect(await f.storage.packs.store.list()).toEqual(before)
  } finally {
    await f.close()
  }
})

it('finishes an old prepared operation without reviving an expired receipt or overwriting its later reuse', async () => {
  const f = await postgresSuiteService(),
    storage = createSuiteStorage(f.database)
  try {
    const { entry, options, request, units, service } = await pendingPreparedInstall(f, storage)
    for (let n = 0; n < 200; n++) await storage.requests.save('new-request-' + n, { id: 'other-' + n, version: '1', status: 'complete' })
    expect(await storage.requests.get(options.requestId)).toBeUndefined()
    await storage.requests.save(options.requestId, { id: 'later-reuse', version: '2', status: 'pending' })
    const reused = await storage.requests.get(options.requestId)
    await service.install(f.actor, units, options, request)
    expect((await storage.installs.get(entry.id))?.record.status).toBe('installed')
    expect(await storage.requests.get(options.requestId)).toEqual(reused)
    expect(await f.runtime.store.list()).toHaveLength(1)
  } finally {
    await f.close()
  }
})

it('commits a shared dependency alias and all consumer references in the same prepared install', async () => {
  const f = await postgresSuiteService(),
    storage = createSuiteStorage(f.database)
  try {
    const base = suiteVersion(1),
      tool = base.items.find(item => item.kind === 'runtime-dependency')!,
      skill = base.items.find(item => item.kind === 'skill')!,
      pack = base.items.find(item => item.kind === 'skill-pack')!,
      entry = { ...base, dependencies: ['shared-cli'], items: [{ ...skill, catalogDependencies: ['shared-cli'] }, pack] }
    await f.runtime.store.save({
      name: 'shared-cli',
      source: 'manual',
      prepareCommand: 'unrelated',
      pathDirectories: ['bin'],
      stage: 'ready',
      checks: [],
      log: '',
      updatedAt: 0,
      current: {
        id: 'c'.repeat(64),
        identity: 'unrelated',
        directory: '/fixture/unrelated',
        mountedPath: '/mounted/unrelated',
        commands: ['unrelated'],
        commandPaths: { unrelated: 'bin/unrelated' },
        pathDirectories: ['bin'],
        bytes: 1,
        isolated: true,
        checks: [],
        log: '',
      },
    })
    const { units, options, request, service } = await pendingPreparedInstall(f, storage, entry),
      dependency = {
        category: 'dependency' as const,
        id: 'shared-cli',
        version: '1',
        title: base.title,
        description: base.description,
        source: base.source,
        items: [{ ...tool, name: 'shared-cli' }],
      },
      definition = suiteRuntimeDependencyDefinition(dependency.items[0]!, 'amd64')!,
      version = await f.dependencies.stageManaged(definition)
    await storage.installs.save({
      id: dependency.id,
      version: '1',
      category: 'dependency',
      status: 'installing',
      entries: [],
      updatedAt: 1,
      log: 'Installing shared dependency.',
    })
    const installed = (await storage.installs.get(dependency.id))!
    await service.install(f.actor, [{ installed, entry: dependency, runtime: [{ definition, version }], skills: [] }, ...units], options, request)
    expect((await storage.installs.get(dependency.id))?.record).toMatchObject({
      dependencyNames: { 'shared-cli': 'shared-cli-1' },
      entries: [{ kind: 'runtime-dependency', name: 'shared-cli-1' }],
    })
    expect((await storage.installs.get(entry.id))?.record).toMatchObject({ status: 'installed', dependencies: ['shared-cli'] })
    expect((await f.storage.library.list()).map(row => row.runtimeDependencies)).toEqual([['shared-cli-1'], ['shared-cli-1']])
    expect((await f.runtime.store.list()).map(row => row.name)).toEqual(['shared-cli', 'shared-cli-1'])
  } finally {
    await f.close()
  }
})
