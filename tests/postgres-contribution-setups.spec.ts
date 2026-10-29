import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { PostgresContributionSetups } from '../src/adapters/postgres-contribution-setups.js'
import { openTestDatabase } from './support/community-application.js'
import { cleanupOwned } from './fixtures/owned-cleanup.js'

it('reads committed setups on demand with the original execution secret identity', async () => {
  const root = await mkdtemp(join(tmpdir(), 'contribution-setups-'))
  const database = await openTestDatabase(root),
    setups = new PostgresContributionSetups(database)
  try {
    await setups.initialize()
    const identity = { id: 'legacy-contribution', revision: 'legacy-revision' },
      reference = 'legacy-reference'
    // Frozen 0.1.25 AAD: do not construct this with the new repository's helpers.
    const field = '["execution","variables",0,"value"]'
    const envelope = database
      .cipher()
      .encrypt(
        { table: 'contribution_setup_secrets', recordId: '["legacy-contribution","legacy-revision","legacy-reference"]', field },
        'fictional-legacy-secret',
      )
    const metadata = {
      execution: { enabled: true, commands: [{ command: 'guide', blocked: [] }], variables: [{ name: 'PRIVATE_KEY', value: '', secret: true }] },
    }
    await database.transaction(async sql => {
      await sql.query('INSERT INTO dsh_phalanx.contribution_setups(reference,id,revision,configuration,fields) VALUES($1,$2,$3,$4,$5)', [
        reference,
        identity.id,
        identity.revision,
        JSON.stringify(metadata),
        JSON.stringify([field]),
      ])
      await sql.query('INSERT INTO dsh_phalanx.contribution_setup_secrets(reference,field,value) VALUES($1,$2,$3)', [
        reference,
        field,
        JSON.stringify(envelope),
      ])
    })
    expect(await setups.read(reference, identity)).toEqual({
      execution: { ...metadata.execution, variables: [{ name: 'PRIVATE_KEY', value: 'fictional-legacy-secret', secret: true }] },
    })
    expect(await setups.read(reference, { ...identity, revision: 'other' })).toBeUndefined()
    await database.query('DELETE FROM dsh_phalanx.contribution_setups WHERE reference=$1', [reference])
    expect(await setups.read(reference, identity)).toBeUndefined()
  } finally {
    await cleanupOwned(
      () => setups.close(),
      () => database.close(),
      () => rm(root, { recursive: true, force: true }),
    )
  }
})

it('reads original plugin setup field identities including an opaque diagnostic request', async () => {
  const root = await mkdtemp(join(tmpdir(), 'contribution-plugin-legacy-'))
  const database = await openTestDatabase(root),
    setups = new PostgresContributionSetups(database)
  try {
    await setups.initialize()
    const identity = { id: 'old-plugin', revision: 'old-revision' },
      reference = 'old-reference'
    const protectedValues = [
      ['["plugin","access","entriesYaml"]', 'main:\n  key: fictional-yaml-key\n'],
      ['["plugin","access","environment",0,"value"]', 'fictional-environment-key'],
      ['["plugin","upstreams",0,"credential"]', 'fictional-upstream-key'],
      ['["plugin","upstreams",0,"headers",0,"value"]', 'fictional-header-key'],
      ['["plugin","upstreams",0,"testRequest"]', '{"method":"POST","path":"/probe","body":{"fictional-private-key":"fictional-private-value"}}'],
    ] as const
    const metadata = {
      plugin: {
        access: { entriesYaml: '', environment: [{ name: 'PRIVATE_KEY', value: '' }] },
        upstreams: [{ name: 'search', baseUrl: 'https://example.test', credential: '', headers: [{ name: 'X-Key', value: '' }], testRequest: '' }],
      },
    }
    await database.transaction(async sql => {
      await sql.query('INSERT INTO dsh_phalanx.contribution_setups(reference,id,revision,configuration,fields) VALUES($1,$2,$3,$4,$5)', [
        reference,
        identity.id,
        identity.revision,
        JSON.stringify(metadata),
        JSON.stringify(protectedValues.map(([field]) => field)),
      ])
      for (const [field, value] of protectedValues) {
        // Literal legacy AAD; deliberately independent of both writer and field walker.
        const envelope = database
          .cipher()
          .encrypt({ table: 'contribution_setup_secrets', recordId: '["old-plugin","old-revision","old-reference"]', field }, value)
        await sql.query('INSERT INTO dsh_phalanx.contribution_setup_secrets(reference,field,value) VALUES($1,$2,$3)', [
          reference,
          field,
          JSON.stringify(envelope),
        ])
      }
    })
    expect(await setups.read(reference, identity)).toEqual({
      plugin: {
        access: { entriesYaml: 'main:\n  key: fictional-yaml-key\n', environment: [{ name: 'PRIVATE_KEY', value: 'fictional-environment-key' }] },
        upstreams: [
          {
            name: 'search',
            baseUrl: 'https://example.test',
            credential: 'fictional-upstream-key',
            headers: [{ name: 'X-Key', value: 'fictional-header-key' }],
            testRequest: { method: 'POST', path: '/probe', body: { 'fictional-private-key': 'fictional-private-value' } },
          },
        ],
      },
    })
    expect(await setups.read(reference, { ...identity, id: 'another' })).toBeUndefined()
    await database.query('UPDATE dsh_phalanx.contribution_setup_secrets SET value=NULL WHERE reference=$1', [reference])
    expect(await setups.read(reference, identity)).toBeUndefined()
  } finally {
    await cleanupOwned(
      () => setups.close(),
      () => database.close(),
      () => rm(root, { recursive: true, force: true }),
    )
  }
})
