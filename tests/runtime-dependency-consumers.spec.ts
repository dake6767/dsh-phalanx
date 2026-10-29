import { asyncSkillFacts } from './fixtures/async-skill-facts.js'
import { expect, it } from 'vitest'
import { RuntimeDependencyConsumers } from '../src/use-cases/runtime-dependency-consumers.js'
it('lists skill and execution references independently, including disabled execution settings', async () => {
  const consumers = new RuntimeDependencyConsumers(
    asyncSkillFacts({ list: () => [{ name: 'reports', description: '', hash: 'source', published: false, importedAt: 0, runtimeDependencies: ['office'] }] }),
    { list: async () => [{ owner: 'skill:private', configuration: { enabled: false, commands: [], variables: [], runtimeDependencies: ['office'] } }] },
  )
  expect(await consumers.list('office')).toEqual([
    { kind: 'skill', name: 'reports' },
    { kind: 'execution', name: 'skill:private' },
  ])
  expect(await consumers.list('missing')).toEqual([])
})
