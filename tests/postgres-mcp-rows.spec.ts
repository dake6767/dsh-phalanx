import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { PostgresMcpStore } from '../src/adapters/postgres-mcp-store.js'
import { openTestDatabase } from './support/community-application.js'

it('reads independently spelled original MCP AAD for current and recursively nested candidates rooted at the outer name', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mcp-original-aad-'))
  const database = await openTestDatabase(root)
  const store = new PostgresMcpStore(database)
  try {
    await store.initialize()
    const actor = { username: 'admin', spaceId: 'space', sessionEpoch: 0 }
    const nested = { name: 'p-deeper', generation: 3, description: '', url: '', headers: [{ name: 'X-Lower', value: '' }] }
    const candidate = {
      name: 'p-private',
      generation: 2,
      description: '',
      url: '',
      credential: '',
      catalogUpdate: { name: 'p-deep-operation', version: '3', status: 'testing', baseGeneration: 2, actor, candidate: nested },
    }
    const configuration = {
      description: '',
      url: 'https://api.example.test/mcp?token=',
      credential: '',
      headers: [{ name: 'X-ApI-Key', value: '' }],
      protectedValues: [''],
      protectedCredentials: [''],
      run: { location: 'shared', command: 'node', args: [''], env: [{ name: 'API_KEY', value: '' }], runtimeDependencies: [] },
      catalogUpdate: { name: 'p-private-operation', version: '2', status: 'testing', baseGeneration: 1, actor, candidate },
    }
    // Record/field strings are frozen here, independently of all writer, mapper and codec helpers.
    const values = [
      { scope: 'current', record: '["p-old","current"]', field: 'url', value: 'https://api.example.test/mcp?token=original-url' },
      { scope: 'current', record: '["p-old","current"]', field: 'credential', value: 'original-credential' },
      { scope: 'current', record: '["p-old","current"]', field: 'headers/x-api-key', value: 'original-header' },
      { scope: 'current', record: '["p-old","current"]', field: 'env/API_KEY', value: 'original-env' },
      { scope: 'current', record: '["p-old","current"]', field: 'run/args/0', value: '--key=original-argument' },
      { scope: 'current', record: '["p-old","current"]', field: 'protectedValues/0', value: 'original-retained' },
      { scope: 'current', record: '["p-old","current"]', field: 'protectedCredentials/0', value: 'original-retained-credential' },
      { scope: 'current/candidate', record: '["p-old","current/candidate"]', field: 'credential', value: 'original-candidate' },
      { scope: 'current/candidate/candidate', record: '["p-old","current/candidate/candidate"]', field: 'headers/x-lower', value: 'original-nested-header' },
    ]
    await database.query('INSERT INTO dsh_phalanx.mcp_services(name,configuration,protected_fields,generation,row_revision) VALUES($1,$2,$3,1,$4)', [
      'p-old',
      JSON.stringify(configuration),
      JSON.stringify(values.map(row => ({ service: 'p-old', scope: row.scope, field: row.field }))),
      'old-revision',
    ])
    for (const row of values) {
      const envelope = database.cipher().encrypt({ table: 'mcp_secrets', recordId: row.record, field: row.field }, row.value)
      await database.query('INSERT INTO dsh_phalanx.mcp_secrets(service,scope,field,value) VALUES($1,$2,$3,$4)', [
        'p-old',
        row.scope,
        row.field,
        JSON.stringify(envelope),
      ])
    }
    const read = await store.get('p-old')
    expect(read).toMatchObject({
      rowRevision: 'old-revision',
      url: values[0]!.value,
      credential: 'original-credential',
      headers: [{ name: 'X-ApI-Key', value: 'original-header' }],
      protectedValues: ['original-retained'],
      protectedCredentials: ['original-retained-credential'],
      run: { env: [{ name: 'API_KEY', value: 'original-env' }], args: ['--key=original-argument'] },
      catalogUpdate: {
        candidate: {
          name: 'p-private',
          credential: 'original-candidate',
          catalogUpdate: { candidate: { name: 'p-deeper', headers: [{ value: 'original-nested-header' }] } },
        },
      },
    })
    expect((await new PostgresMcpStore(database).get('p-old'))?.credential).toBe('original-credential')
    await database.query('DELETE FROM dsh_phalanx.mcp_secrets WHERE service=$1 AND scope=$2 AND field=$3', ['p-old', 'current', 'env/API_KEY'])
    await expect(store.get('p-old')).rejects.toThrow()
  } finally {
    try {
      await store.close()
    } finally {
      try {
        await database.close()
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    }
  }
})
