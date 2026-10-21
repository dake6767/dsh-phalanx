import { expect, it } from 'vitest'
import { instanceResourceArguments, legacyInstanceResources } from '../src/dsh/member-resource-limits.js'
import { UNLIMITED_INSTANCE_RESOURCES } from '../src/domain/instance-resources.js'

it('imports legacy deployment flags using the last supplied value and preserves byte units', () => {
  expect(legacyInstanceResources(undefined)).toEqual(UNLIMITED_INSTANCE_RESOURCES)
  expect(legacyInstanceResources(['--memory', '1g', '--cpus', '0.5', '--pids-limit', '64', '--memory', '512m'])).toEqual({ memoryMiB: 512, cpus: 0.5, pids: 64 })
  expect(legacyInstanceResources(['--memory', '64k'])).toEqual({ memoryMiB: 1 / 16, cpus: null, pids: null })
  for (const args of [['--privileged', 'true'], ['--memory'], ['--cpus', '0'], ['--pids-limit', '0'], ['--memory-swap', '128m']]) expect(() => legacyInstanceResources(args)).toThrow()
})

it('disables swap for bounded memory and explicitly removes the runtime default PID cap', () => {
  expect(instanceResourceArguments({ cpus: 0.5, memoryMiB: 512, pids: 64 })).toEqual(['--cpus', '0.5', '--memory', '536870912', '--memory-swap', '536870912', '--pids-limit', '64'])
  expect(instanceResourceArguments(UNLIMITED_INSTANCE_RESOURCES)).toEqual(['--cpus', '0', '--memory', '0', '--memory-swap', '-1', '--pids-limit', '-1'])
})
