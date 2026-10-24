import { expect, it } from 'vitest'
import { executionConfiguration } from '../src/domain/execution-configuration.js'

const configuration = { enabled: true, commands: [{ command: 'scripts/submit.py', blocked: ['apikey-get'] }, { command: 'scripts/query.py', blocked: [] }], variables: [{ name: 'MPS_SECRET_ID', secret: true, value: 'fixture-id' }, { name: 'MPS_SECRET_KEY', secret: true, value: 'fixture-key' }, { name: 'MPS_REGION', secret: false, value: 'region-one' }] }
it('preserves multiple commands and independent variable classifications', () => {
  expect(executionConfiguration(configuration)).toEqual(configuration)
  expect(executionConfiguration({ ...configuration, variables: configuration.variables.map(({ name, secret }) => ({ name, secret })) }, configuration)).toEqual(configuration)
})
it.each(['PATH', 'HOME', 'TMPDIR', 'DSH_HOME', 'DSH_PHALANX_TOKEN', 'LD_PRELOAD', 'DYLD_INSERT_LIBRARIES', 'NODE_OPTIONS', 'PYTHONPATH', 'PYTHONHOME', 'BASH_ENV', 'ENV'])('rejects reserved execution variable %s', name => {
  expect(() => executionConfiguration({ ...configuration, variables: [{ name, value: 'untrusted', secret: false }] })).toThrow(expect.objectContaining({ code: 'execution-config-invalid' }))
})

it('keeps the suite origin through validation and a store reload, and rejects foreign origins on load', async () => {
  const { FileExecutionConfigurations } = await import('../src/adapters/execution-configuration-store.js')
  const { mkdtemp, rm, writeFile } = await import('node:fs/promises'), { tmpdir } = await import('node:os'), { join } = await import('node:path')
  const root = await mkdtemp(join(tmpdir(), 'execution-suite-origin-'))
  try {
    const owned = { ...configuration, commands: [{ command: 'scripts/cloud.py', source: 'scripts/audio.py', blockedOptions: ['--base-url'], blocked: [] }], optionalVariables: ['MPS_REGION'], suiteOrigin: 'suite:minimax' }
    expect(executionConfiguration({ ...configuration, enabled: false }, owned)).toMatchObject({ suiteOrigin: 'suite:minimax', enabled: false })
    new FileExecutionConfigurations(join(root, 'configuration.json')).save('skill:mmx-cli', owned)
    expect(new FileExecutionConfigurations(join(root, 'configuration.json')).get('skill:mmx-cli')).toEqual(owned)
    await writeFile(join(root, 'foreign.json'), JSON.stringify({ schema: 1, owners: [{ owner: 'skill:x', configuration: { ...configuration, suiteOrigin: 'manual' } }] }))
    expect(() => new FileExecutionConfigurations(join(root, 'foreign.json'))).toThrow('Execution configuration could not be loaded')
  } finally { await rm(root, { recursive: true, force: true }) }
})

it.each(['../outside.py', '/outside.py', 'scripts/../outside.py', 'scripts//outside.py'])('refuses delegated script source %s', source => {
  expect(() => executionConfiguration({ ...configuration, commands: [{ command: 'scripts/cloud.py', source, blocked: [] }] })).toThrow(expect.objectContaining({ code: 'execution-config-invalid' }))
})

it.each(['--', 'base-url', '--base-url=value'])('rejects invalid protected option %s', option => {
  expect(() => executionConfiguration({ ...configuration, commands: [{ command: 'cloud-audio', blocked: [], blockedOptions: [option] }] })).toThrow(expect.objectContaining({ code: 'execution-config-invalid' }))
})
