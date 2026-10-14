import { expect, it } from 'vitest'
import { RuntimeDependencyConsumers } from '../src/use-cases/runtime-dependency-consumers.js'
it('lists skill and execution references independently, including disabled execution settings', () => {
  const consumers = new RuntimeDependencyConsumers({ list: () => [{ name: 'reports', description: '', hash: 'source', published: false, importedAt: 0, runtimeDependencies: ['office'] }] },
    { list: () => [{ owner: 'skill:private', configuration: { enabled: false, commands: [], variables: [], runtimeDependencies: ['office'] } }] })
  expect(consumers.list('office')).toEqual([{ kind: 'skill', name: 'reports' }, { kind: 'execution', name: 'skill:private' }])
  expect(consumers.list('missing')).toEqual([])
})
