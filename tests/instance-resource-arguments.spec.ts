import { expect, it } from 'vitest'
import { instanceResourceArguments } from '../src/dsh/member-resource-limits.js'
import { UNLIMITED_INSTANCE_RESOURCES } from '../src/domain/instance-resources.js'

it('disables swap for bounded memory and explicitly removes the runtime default PID cap', () => {
  expect(instanceResourceArguments({ cpus: 0.5, memoryMiB: 512, pids: 64 })).toEqual([
    '--cpus',
    '0.5',
    '--memory',
    '536870912',
    '--memory-swap',
    '536870912',
    '--pids-limit',
    '64',
  ])
  expect(instanceResourceArguments(UNLIMITED_INSTANCE_RESOURCES)).toEqual(['--cpus', '0', '--memory', '0', '--memory-swap', '-1', '--pids-limit', '-1'])
})
