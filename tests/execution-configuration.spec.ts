import { seedExecutionOwners } from './fixtures/execution-owners.js'
import { expect, it } from 'vitest'
import { executionConfiguration } from '../src/domain/execution-configuration.js'

const configuration = {
  enabled: true,
  commands: [
    { command: 'scripts/submit.py', blocked: ['apikey-get'] },
    { command: 'scripts/query.py', blocked: [] },
  ],
  variables: [
    { name: 'MPS_SECRET_ID', secret: true, value: 'fixture-id' },
    { name: 'MPS_SECRET_KEY', secret: true, value: 'fixture-key' },
    { name: 'MPS_REGION', secret: false, value: 'region-one' },
  ],
}
it('preserves multiple commands and independent variable classifications', () => {
  expect(executionConfiguration(configuration)).toEqual(configuration)
  expect(executionConfiguration({ ...configuration, variables: configuration.variables.map(({ name, secret }) => ({ name, secret })) }, configuration)).toEqual(
    configuration,
  )
})
it.each([
  'PATH',
  'HOME',
  'TMPDIR',
  'DSH_HOME',
  'DSH_PHALANX_TOKEN',
  'LD_PRELOAD',
  'DYLD_INSERT_LIBRARIES',
  'NODE_OPTIONS',
  'PYTHONPATH',
  'PYTHONHOME',
  'BASH_ENV',
  'ENV',
])('rejects reserved execution variable %s', name => {
  expect(() => executionConfiguration({ ...configuration, variables: [{ name, value: 'untrusted', secret: false }] })).toThrow(
    expect.objectContaining({ code: 'execution-config-invalid' }),
  )
})

it('keeps the suite origin through validation and PostgreSQL reopen, and rejects foreign origins on load', async () => {
  const { PostgresExecutionConfigurations } = await import('../src/adapters/postgres-execution-configurations.js')
  const { openTestDatabase } = await import('./support/community-application.js')
  const { mkdtemp, rm } = await import('node:fs/promises'),
    { tmpdir } = await import('node:os'),
    { join } = await import('node:path')
  const root = await mkdtemp(join(tmpdir(), 'execution-suite-origin-'))
  const database = await openTestDatabase(root)
  try {
    const owned = {
      ...configuration,
      commands: [{ command: 'scripts/cloud.py', source: 'scripts/audio.py', blockedOptions: ['--base-url'], blocked: [] }],
      optionalVariables: ['MPS_REGION'],
      suiteOrigin: 'suite:minimax',
    }
    expect(executionConfiguration({ ...configuration, enabled: false }, owned)).toMatchObject({ suiteOrigin: 'suite:minimax', enabled: false })
    await seedExecutionOwners(database, ['skill:mmx-cli'])
    const store = new PostgresExecutionConfigurations(database)
    await store.initialize()
    await store.save('skill:mmx-cli', owned)
    const reopened = new PostgresExecutionConfigurations(database)
    await reopened.initialize()
    expect(await reopened.get('skill:mmx-cli')).toMatchObject(owned)
    await database.query(`UPDATE dsh_phalanx.execution_configurations SET configuration=jsonb_set(configuration,'{suiteOrigin}','"manual"')`)
    await expect(reopened.get('skill:mmx-cli')).rejects.toThrow('Execution configuration could not be loaded')
  } finally {
    await database.close()
    await rm(root, { recursive: true, force: true })
  }
})

it.each(['../outside.py', '/outside.py', 'scripts/../outside.py', 'scripts//outside.py'])('refuses delegated script source %s', source => {
  expect(() => executionConfiguration({ ...configuration, commands: [{ command: 'scripts/cloud.py', source, blocked: [] }] })).toThrow(
    expect.objectContaining({ code: 'execution-config-invalid' }),
  )
})

it.each(['--', 'base-url', '--base-url=value'])('rejects invalid protected option %s', option => {
  expect(() => executionConfiguration({ ...configuration, commands: [{ command: 'cloud-audio', blocked: [], blockedOptions: [option] }] })).toThrow(
    expect.objectContaining({ code: 'execution-config-invalid' }),
  )
})
