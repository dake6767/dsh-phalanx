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
