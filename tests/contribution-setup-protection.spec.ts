import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import type { ContributionSetup } from '../src/domain/member-contribution.js'
import { PostgresContributionSetups } from '../src/adapters/postgres-contribution-setups.js'
import { openTestDatabase } from './support/community-application.js'

const plugin: ContributionSetup = {
  published: true,
  plugin: {
    upstreams: [
      {
        name: 'search',
        baseUrl: 'https://example.test',
        credential: 'fictional-intent-upstream-key',
        headers: [{ name: 'X-Key', value: 'fictional-intent-header-key' }],
      },
    ],
    access: { environment: [{ name: 'PRIVATE_KEY', value: 'fictional-intent-environment-key' }], entriesYaml: 'main:\n  key: fictional-intent-yaml-key\n' },
  },
}
const execution: ContributionSetup = {
  execution: {
    enabled: true,
    commands: [{ command: 'guide', blocked: [] }],
    variables: [
      { name: 'PRIVATE_KEY', value: 'fictional-intent-execution-key', secret: true },
      { name: 'PUBLIC_NAME', value: 'ordinary-value', secret: false },
    ],
  },
  groups: [{ id: 'team', revision: 'group-revision' }],
}
const known = [
  'fictional-intent-upstream-key',
  'fictional-intent-header-key',
  'fictional-intent-environment-key',
  'fictional-intent-yaml-key',
  'fictional-intent-execution-key',
]

it('protects diagnostic input even when it reuses a credential omitted from the adoption draft', async () => {
  const root = await mkdtemp(join(tmpdir(), 'contribution-secret-diagnostic-'))
  const database = await openTestDatabase(root),
    setups = new PostgresContributionSetups(database)
  const setup: ContributionSetup = {
    plugin: {
      upstreams: [
        {
          name: 'search',
          baseUrl: 'https://example.test',
          headers: [],
          testRequest: {
            method: 'POST',
            path: '/test?token=fictional-existing-query-key',
            body: { 'fictional-object-key-secret': 'ordinary', nested: ['fictional-existing-body-key', { key: 'fictional-intent-yaml-key' }] },
          },
        },
      ],
      access: plugin.plugin!.access,
    },
  }
  try {
    await setups.initialize()
    const identity = { id: 'id', revision: 'revision' },
      reference = await setups.save(identity, setup)
    const metadata = JSON.stringify(await database.query('SELECT configuration,fields FROM dsh_phalanx.contribution_setups'))
    for (const value of ['fictional-existing-query-key', 'fictional-existing-body-key', 'fictional-intent-yaml-key', 'fictional-object-key-secret'])
      expect(metadata).not.toContain(value)
    const reopened = new PostgresContributionSetups(database)
    await reopened.initialize()
    expect(await reopened.read(reference, identity)).toEqual(setup)
    await reopened.close()
  } finally {
    await setups.close()
    await database.close()
    await rm(root, { recursive: true, force: true })
  }
})

it.each([
  { kind: 'plugin', setup: plugin },
  { kind: 'execution', setup: execution },
])('keeps $kind setup secrets encrypted and reads them by identity after reopening', async ({ setup }) => {
  const root = await mkdtemp(join(tmpdir(), 'contribution-setup-protection-')),
    database = await openTestDatabase(root),
    setups = new PostgresContributionSetups(database)
  try {
    await setups.initialize()
    const identity = { id: 'contribution', revision: 'revision' },
      reference = await setups.save(identity, setup)
    const persisted =
      JSON.stringify(await database.query('SELECT * FROM dsh_phalanx.contribution_setups')) +
      JSON.stringify(await database.query('SELECT * FROM dsh_phalanx.contribution_setup_secrets'))
    for (const value of known) expect(persisted).not.toContain(value)
    expect(persisted).toContain('ciphertext')
    const reopened = new PostgresContributionSetups(database)
    await reopened.initialize()
    try {
      expect(await reopened.read(reference, identity)).toEqual(setup)
      expect(await reopened.read(reference, { ...identity, revision: 'other' })).toBeUndefined()
      await reopened.remove(reference)
      expect(await reopened.read(reference, identity)).toBeUndefined()
    } finally {
      await reopened.close()
    }
    expect(await database.query('SELECT * FROM dsh_phalanx.contribution_setup_secrets')).toEqual([])
  } finally {
    await setups.close()
    await database.close()
    await rm(root, { recursive: true, force: true })
  }
})

it('keeps both setup tables empty when PostgreSQL rejects COMMIT', async () => {
  const root = await mkdtemp(join(tmpdir(), 'contribution-setup-commit-')),
    database = await openTestDatabase(root),
    setups = new PostgresContributionSetups(database)
  try {
    await setups.initialize()
    await database.query(`CREATE TABLE dsh_phalanx.commit_parents(id integer PRIMARY KEY);
      CREATE TABLE dsh_phalanx.commit_children(id integer REFERENCES dsh_phalanx.commit_parents(id) DEFERRABLE INITIALLY DEFERRED);
      CREATE FUNCTION dsh_phalanx.reject_setup_commit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO dsh_phalanx.commit_children VALUES(42); RETURN NULL; END $$;
      CREATE TRIGGER reject_setup_commit AFTER INSERT ON dsh_phalanx.contribution_setups FOR EACH ROW EXECUTE FUNCTION dsh_phalanx.reject_setup_commit();`)
    await expect(setups.save({ id: 'contribution', revision: 'revision' }, plugin)).rejects.toMatchObject({ code: 'query-failed', sqlState: '23503' })
    expect(await database.query('SELECT * FROM dsh_phalanx.contribution_setups')).toEqual([])
    expect(await database.query('SELECT * FROM dsh_phalanx.contribution_setup_secrets')).toEqual([])
  } finally {
    await setups.close()
    await database.close()
    await rm(root, { recursive: true, force: true })
  }
})

it('freezes accepted identity and secret setup before a blocked SQL write yields to its caller', async () => {
  const root = await mkdtemp(join(tmpdir(), 'contribution-setup-frozen-')),
    database = await openTestDatabase(root),
    setups = new PostgresContributionSetups(database)
  let release!: () => void, entered!: () => void, holder: Promise<void> | undefined, writing: Promise<string> | undefined
  const gate = new Promise<void>(resolve => {
      release = resolve
    }),
    began = new Promise<void>(resolve => {
      entered = resolve
    })
  try {
    await setups.initialize()
    const identity = { id: 'contribution', revision: 'revision' },
      input = { ...structuredClone(plugin) },
      original = structuredClone({ identity, input })
    holder = database.transaction(async sql => {
      await sql.query('LOCK TABLE dsh_phalanx.contribution_setups IN SHARE MODE')
      entered()
      await gate
    })
    await began
    writing = setups.save(identity, input)
    await expect
      .poll(async () =>
        Number(
          (
            await database.query<{ waiting: string }>(
              "SELECT count(*) AS waiting FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'",
            )
          )[0]!.waiting,
        ),
      )
      .toBeGreaterThan(0)
    identity.id = 'changed'
    identity.revision = 'changed'
    input.plugin = { access: { environment: [], entriesYaml: 'changed' }, upstreams: [] }
    input.published = false
    release()
    await holder
    const reference = await writing
    expect(await setups.read(reference, original.identity)).toEqual(original.input)
    const reopened = new PostgresContributionSetups(database)
    await reopened.initialize()
    try {
      expect(await reopened.read(reference, original.identity)).toEqual(original.input)
    } finally {
      await reopened.close()
    }
  } finally {
    release()
    await Promise.allSettled([...(holder ? [holder] : []), ...(writing ? [writing] : [])])
    await setups.close()
    await database.close()
    await rm(root, { recursive: true, force: true })
  }
})
