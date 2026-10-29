import { pluginMaintenanceRevision } from '../src/domain/plugin-library.js'
import { PostgresExpertRows } from '../src/adapters/postgres-expert-rows.js'
import { PluginLibraryMembership } from '../src/use-cases/plugin-library-membership.js'
import { PostgresPluginSelections } from '../src/adapters/postgres-plugin-selections.js'
import { PostgresExpertReferences } from '../src/adapters/postgres-expert-references.js'
import { PluginAccessAdministration } from '../src/use-cases/plugin-access-administration.js'
import { PluginUpstreamAdministration } from '../src/use-cases/plugin-upstream-administration.js'
import { PluginContributionAdministration } from '../src/use-cases/plugin-contribution-administration.js'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { postgresSkillService } from './fixtures/postgres-skill-service.js'
import { createContributionStorage } from '../src/composition/contribution-storage.js'
import { PostgresPluginGrants } from '../src/adapters/postgres-plugin-grants.js'
import { ManagedPluginAdministration } from '../src/use-cases/managed-plugin-administration.js'
import { PostgresPluginLibraryStore } from '../src/adapters/postgres-plugin-library.js'
import { PostgresPluginAccessStore } from '../src/adapters/postgres-plugin-access-store.js'
import { PostgresPluginUpstreams } from '../src/adapters/postgres-plugin-upstreams.js'
import { FilePluginContributionPreparation } from '../src/adapters/plugin-contribution-preparation.js'
import { YamlPluginAccessSyntax } from '../src/adapters/plugin-access-syntax.js'
import { pluginCompatibilityTarget } from '../src/adapters/runtime-revision.js'
import { PluginLibrary } from '../src/use-cases/plugin-library.js'
import { PluginContributions } from '../src/use-cases/plugin-contributions.js'
import { ContributionTransactions } from '../src/use-cases/contribution-transactions.js'
import type { ContributionSetup, MemberContribution } from '../src/domain/member-contribution.js'

it('commits plugin adoption, protected configuration and decisions together, retaining promoted bytes even when publication fails', async () => {
  const fixture = await postgresSkillService(),
    storage = createContributionStorage(fixture.database),
    store = new PostgresPluginLibraryStore(fixture.database),
    grants = new PostgresPluginGrants(fixture.database),
    access = new PostgresPluginAccessStore(fixture.database),
    upstreams = new PostgresPluginUpstreams(fixture.database),
    target = pluginCompatibilityTarget()
  const library = new PluginLibrary(
    fixture.accounts,
    store,
    {
      prepare: async () => {
        throw Error('already prepared')
      },
    },
    undefined,
    { impact: async () => ({ groups: 0, members: 0 }), revoke: async () => {} },
    target,
  )
  let failPublication = false
  const actions = new ContributionTransactions(
    {
      run: async (operation, committed) => {
        const result = await storage.work.run(operation, committed)
        if (failPublication) throw Error('publication failed after commit')
        return result
      },
    },
    new YamlPluginAccessSyntax(),
  )
  const config = {
    command: 'unused',
    args: [],
    dataRoot: fixture.root,
    defaultModel: { provider: 'fixture', model: 'fixture', upstream: { baseUrl: 'https://example.test' } },
  }
  const service = new PluginContributions(new FilePluginContributionPreparation(config), library)
  const archive = Buffer.from('prepared immutable plugin fixture'),
    digest = createHash('sha512').update(archive).digest(),
    artifact = 'artifacts/' + digest.toString('hex'),
    privateRoot = join(fixture.root, 'contributions/plugin-intake/plugins', artifact),
    liveRoot = join(fixture.root, 'plugins', artifact),
    candidate = { packageName: 'atomic-search', version: '1.0.0' }
  const prepared = {
    ...candidate,
    integrity: 'sha512-' + digest.toString('base64'),
    artifact,
    preparationId: 'a'.repeat(40) + '-' + randomUUID(),
    runtimeRevision: target.split('/').at(-1)!,
    title: 'Search',
    description: '',
    dependencies: {},
    bundlePatch: '[{"insert":[{"id":"search","name":"atomic-search"}]}]',
  }
  const row: MemberContribution = {
    id: 'first',
    revision: 'one',
    kind: 'plugin',
    ...{ name: candidate.packageName, hash: 'a'.repeat(64), description: '', markdown: '', files: [] },
    contributor: fixture.member,
    declaration: { purpose: 'Share search' },
    submittedAt: 1,
    updatedAt: 1,
    status: 'pending',
    plugin: { candidate, prepared, checkedFor: target },
  }
  let setup: ContributionSetup = {
    maintenance: { assignMaintainer: true, anonymous: true },
    published: true,
    credentialSharingConfirmed: true,
    configuration: { access: 'none', upstreams: 'none' },
    plugin: {
      access: { environment: [{ name: 'SEARCH_KEY', value: '{access-token}' }], entriesYaml: 'search:\n  baseURL: "{upstream:search}"' },
      upstreams: [{ name: 'search', baseUrl: 'https://provider.example', credential: 'fictional-adoption-secret', headers: [] }],
    },
  }
  try {
    await access.initialize()
    await upstreams.initialize()
    await mkdir(join(privateRoot, 'prepared', prepared.preparationId), { recursive: true })
    await writeFile(join(privateRoot, 'original.tgz'), archive)
    await storage.actions.submit(fixture.member, row)
    const bob = await fixture.accounts.create({ username: 'bob', email: '', password: 'password' })
    await storage.actions.submit(bob, { ...row, id: 'second', revision: 'two', contributor: bob })
    const managed = new ManagedPluginAdministration(
      fixture.accounts,
      store,
      grants,
      { effective: async () => [] },
      {
        status: () => {
          throw Error('no runtime work during contribution commit')
        },
      },
      {
        restart: async () => {
          throw Error('no restart during contribution commit')
        },
      },
      prepared.runtimeRevision,
    )
    const group = (await managed.contributionGroups(fixture.actor, row.name))[0]!
    setup = { ...setup, groups: [{ id: group.group.id, revision: group.revision }] }
    const record = (await storage.rows.get(row.id))!,
      preview = await service.review(fixture.actor, row, 'review')
    const adopt = () =>
      service.confirm(
        fixture.actor,
        row,
        preview,
        () => {},
        setup,
        (plugin, committed) => actions.plugin(fixture.actor, record, plugin, setup, 2, committed, preview.revision),
      )
    await fixture.database.query(`CREATE TABLE dsh_phalanx.reject_plugin_parent(id integer PRIMARY KEY);
      CREATE TABLE dsh_phalanx.reject_plugin_child(id integer REFERENCES dsh_phalanx.reject_plugin_parent DEFERRABLE INITIALLY DEFERRED);
      CREATE FUNCTION dsh_phalanx.reject_plugin() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN INSERT INTO dsh_phalanx.reject_plugin_child VALUES(1); RETURN NULL; END $$;
      CREATE TRIGGER reject_plugin AFTER INSERT ON dsh_phalanx.plugin_access_settings FOR EACH ROW EXECUTE FUNCTION dsh_phalanx.reject_plugin();`)
    await expect(adopt()).rejects.toMatchObject({ sqlState: '23503' })
    expect(await store.list()).toEqual([])
    expect(await grants.get(group.group.id)).toEqual([])
    expect(await grants.contributionReceipt(group.group.id, row.name)).toBeUndefined()
    expect(await upstreams.list(row.name)).toEqual([])
    expect(await access.get(row.name)).toBeUndefined()
    expect(await storage.rows.get(row.id)).toEqual(record)
    expect((await storage.rows.get('second'))?.row.status).toBe('pending')
    await expect(readFile(join(liveRoot, 'original.tgz'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(join(privateRoot, 'original.tgz'))).toEqual(archive)
    await fixture.database.query('DROP TRIGGER reject_plugin ON dsh_phalanx.plugin_access_settings')
    failPublication = true
    await expect(adopt()).rejects.toThrow('publication failed after commit')
    expect(await readFile(join(liveRoot, 'original.tgz'))).toEqual(archive)
    expect((await store.list())[0]).toMatchObject({ published: true, contributionReceipt: { id: row.id, revision: row.revision } })
    expect((await upstreams.list(row.name))[0]?.credential).toBe('fictional-adoption-secret')
    expect(await grants.get(group.group.id)).toEqual([row.name])
    expect(await grants.contributionReceipt(group.group.id, row.name)).toEqual({ id: row.id, revision: row.revision })
    expect((await store.list())[0]?.provenance).toMatchObject({
      anonymous: true,
      maintainer: { username: fixture.member.username, spaceId: fixture.member.spaceId },
    })
    expect((await storage.rows.get(row.id))?.row.status).toBe('adopted')
    expect((await storage.rows.get('second'))?.row.status).toBe('declined')
    failPublication = false
    await library.setMaintainer(fixture.actor, row.name, bob.username, pluginMaintenanceRevision((await store.list())[0]!))
    const previous = await store.list()
    await upstreams.save(row.name, [{ ...setup.plugin!.upstreams[0]!, credential: 'fictional-newer-secret', headers: [] }])
    await storage.actions.submit(bob, {
      ...row,
      id: 'third',
      revision: 'three',
      contributor: bob,
      hash: 'b'.repeat(64),
      plugin: { ...row.plugin!, candidate: { ...row.plugin!.candidate, version: '1.0.1' }, prepared: { ...row.plugin!.prepared, version: '1.0.1' } },
    })
    await actions.plugin(
      fixture.actor,
      record,
      previous[0]!,
      setup,
      3,
      () => {
        throw Error('an old receipt must not retain a new preparation')
      },
      preview.revision,
    )
    expect(await store.list()).toEqual(previous)
    expect((await upstreams.list(row.name))[0]?.credential).toBe('fictional-newer-secret')
    expect((await storage.rows.get('third'))?.row.status).toBe('pending')
  } finally {
    await library.stop()
    await access.close()
    await upstreams.close()
    await fixture.close()
  }
})

it.each(['selection', 'expert-removal'] as const)(
  'retains newer administrator settings and rejects changed %s impact before adopting a fresh review',
  async scenario => {
    const fixture = await postgresSkillService(),
      storage = createContributionStorage(fixture.database),
      store = new PostgresPluginLibraryStore(fixture.database),
      access = new PostgresPluginAccessStore(fixture.database),
      upstreams = new PostgresPluginUpstreams(fixture.database),
      choices = new PostgresPluginSelections(fixture.database),
      grants = new PostgresPluginGrants(fixture.database),
      syntax = new YamlPluginAccessSyntax()
    const library = new PluginLibrary(
      fixture.accounts,
      store,
      {
        prepare: async () => {
          throw Error('already prepared')
        },
      },
      undefined,
      new PluginLibraryMembership(fixture.accounts, grants, choices),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      new PostgresExpertReferences(fixture.database),
    )
    const accessAdmin = new PluginAccessAdministration(fixture.accounts, store, access, upstreams, syntax),
      upstreamAdmin = new PluginUpstreamAdministration(fixture.accounts, store, upstreams, accessAdmin),
      administration = new PluginContributionAdministration(accessAdmin, upstreamAdmin, syntax)
    const service = new PluginContributions(
      {
        prepare: async () => {
          throw Error('already prepared')
        },
        publish: async (artifact, commit) => commit(artifact, () => {}),
        recover: async () => {},
      },
      library,
      administration,
    )
    const candidate = { packageName: 'updated-search', version: '2.0.0' },
      prepared = {
        ...candidate,
        integrity: 'sha512-' + createHash('sha512').update('updated').digest('base64'),
        artifact: 'artifacts/updated',
        runtimeRevision: 'runtime',
        title: 'Search',
        description: '',
        dependencies: {},
        bundlePatch: '[{"insert":[{"id":"search","name":"updated-search"}]}]',
      }
    const row: MemberContribution = {
      id: 'update',
      revision: 'two',
      kind: 'plugin',
      name: candidate.packageName,
      hash: 'b'.repeat(64),
      description: '',
      markdown: '',
      files: [],
      contributor: fixture.member,
      declaration: { purpose: 'Update' },
      submittedAt: 1,
      updatedAt: 1,
      status: 'pending',
      plugin: { candidate, prepared },
    }
    try {
      await access.initialize()
      await upstreams.initialize()
      await store.save({ ...candidate, version: '1.0.0', current: null, stage: 'failed', published: false })
      const expertRows = new PostgresExpertRows(fixture.database)
      if (scenario === 'expert-removal')
        await expertRows.save({
          id: 'reader',
          name: 'Reader',
          description: 'Reads search results',
          icon: 'R',
          persona: 'Read.',
          examples: [],
          revision: 1,
          published: false,
          skills: [],
          skillPacks: [],
          plugins: [row.name],
          mcp: [],
          model: null,
        })
      const beforeAccess = { environment: [{ name: 'SEARCH_MODE', value: 'original' }], entriesYaml: '', entries: {} },
        beforeUpstreams = [{ name: 'search', baseUrl: 'https://provider.example', credential: 'fictional-original', headers: [] }]
      await access.save(row.name, beforeAccess)
      await upstreams.save(row.name, beforeUpstreams)
      await storage.actions.submit(fixture.member, row)
      const record = (await storage.rows.get(row.id))!,
        preview = await service.review(fixture.actor, row, 'review'),
        setup: ContributionSetup = {
          configuration: preview.configuration!,
          published: true,
          credentialSharingConfirmed: true,
          plugin: {
            access: { environment: [{ name: 'SEARCH_MODE', value: 'submitted' }], entriesYaml: '' },
            upstreams: [{ ...beforeUpstreams[0]!, credential: 'fictional-submitted' }],
          },
        }
      await service.validate(fixture.actor, row, setup)
      await upstreams.save(row.name, [{ ...beforeUpstreams[0]!, credential: 'fictional-newer-administrator' }])
      let release!: () => void, entered!: () => void
      const gate = new Promise<void>(resolve => {
          release = resolve
        }),
        began = new Promise<void>(resolve => {
          entered = resolve
        })
      const adopting = service.confirm(
        fixture.actor,
        row,
        preview,
        () => {},
        setup,
        async (plugin, committed) => {
          entered()
          await gate
          await storage.actions.plugin(fixture.actor, record, plugin, setup, 2, committed, preview.revision)
        },
      )
      const rejected = expect(adopting).rejects.toMatchObject({ code: 'plugin-impact-changed' })
      let releaseExpert!: () => void, expertEntered!: () => void, editing: Promise<void> | undefined
      const expertGate = new Promise<void>(resolve => {
          releaseExpert = resolve
        }),
        expertBegan = new Promise<void>(resolve => {
          expertEntered = resolve
        })
      try {
        await began
        if (scenario === 'selection') await choices.set(fixture.member.spaceId, [row.name])
        else {
          const beforeExpert = (await expertRows.get('reader'))!
          editing = fixture.database.transaction(async sql => {
            await new PostgresExpertRows({ sql, cipher: fixture.database.cipher() }).save({ ...beforeExpert, plugins: [], revision: 2 })
            expertEntered()
            await expertGate
          })
          await expertBegan
        }
        release()
        if (editing) {
          await expect
            .poll(async () =>
              Number(
                (
                  await fixture.database.query<{ waiting: string }>(
                    "SELECT count(*) AS waiting FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'",
                  )
                )[0]!.waiting,
              ),
            )
            .toBeGreaterThan(0)
          releaseExpert()
          await editing
        }
        await rejected
      } finally {
        release()
        releaseExpert()
        await Promise.allSettled([adopting, rejected, ...(editing ? [editing] : [])])
      }
      expect((await store.list())[0]?.version).toBe('1.0.0')
      expect((await storage.rows.get(row.id))?.row.status).toBe('pending')
      if (scenario === 'selection') expect(await choices.get(fixture.member.spaceId)).toEqual([row.name])
      else expect((await expertRows.get('reader'))?.plugins).toEqual([])
      const fresh = await service.review(fixture.actor, row, 'fresh-review')
      await service.confirm(
        fixture.actor,
        row,
        fresh,
        () => {},
        setup,
        (plugin, committed) => storage.actions.plugin(fixture.actor, record, plugin, setup, 2, committed, fresh.revision),
      )
      expect((await store.list())[0]).toMatchObject({ version: '2.0.0', published: false, contributionDistributionReceipt: { id: row.id } })
      expect((await upstreams.list(row.name))[0]?.credential).toBe('fictional-newer-administrator')
      expect(await access.get(row.name)).toMatchObject(beforeAccess)
      const result = (await storage.rows.get(row.id))!
      expect(result.row).toMatchObject({ status: 'adopted', reason: expect.stringContaining('newer administrator configuration was retained') })
      expect(await access.receipt(row.name)).toMatchObject({ id: row.id, warnings: [result.row.reason] })
      expect(await upstreams.receipt(row.name)).toMatchObject({ id: row.id, warnings: [result.row.reason] })
    } finally {
      await library.stop()
      await access.close()
      await upstreams.close()
      await fixture.close()
    }
  },
)
