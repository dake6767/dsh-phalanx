import { expect, it } from 'vitest'
import { pluginAccessConfiguration } from '../src/domain/plugin-access.js'
import { RuntimeDependencyConsumers } from '../src/use-cases/runtime-dependency-consumers.js'

it('accepts only declared dependency placeholders, including Unicode and punctuation, in environment templates', () => {
  const input = (value: string) => ({ entriesYaml: '', environment: [{ name: 'SDK_ROOT', value }] })
  const check = (value: string) => pluginAccessConfiguration(input(value), () => ({}), [], new Set(), new Set(), new Set(['文档.sdk-v1', 'python_lib']))
  expect(check('prefix:{dependency:文档.sdk-v1}/sdk:{dependency:python_lib}').environment).toHaveLength(1)
  for (const value of ['{dependency:missing}', '{dependency:}', '{dependency:has space}', '{dependency:文档.sdk-v1', '{dependency:{bad}}']) expect(() => check(value)).toThrow()
  expect(() => pluginAccessConfiguration({ ...input('literal'), entriesYaml: 'entry' }, () => ({ entry: { path: '{dependency:文档.sdk-v1}' } }), ['entry'], new Set(), new Set(), new Set(['文档.sdk-v1']))).toThrow()
})
it('counts unpublished and disabled plugin declarations as references protecting dependency deletion', () => {
  const consumers = new RuntimeDependencyConsumers({ list: () => [] }, { list: () => [] }, undefined, { list: () => [{ packageName: 'office', version: '1.0.0', stage: 'failed', current: null, published: false, runtimeDependencies: ['sdk'] }] })
  expect(consumers.list('sdk')).toEqual([{ kind: 'plugin', name: 'office' }])
})

it('saves validated plugin declarations and preserves them across prepared replacements and adoption', async () => {
  const { PluginLibrary } = await import('../src/use-cases/plugin-library.js')
  const actor = { username: 'admin', spaceId: 'space', sessionEpoch: 0 }
  let row: import('../src/domain/plugin-library.js').LibraryPlugin = { packageName: 'office', version: '1.0.0', stage: 'failed', current: null, published: false }
  const values = { environment: [{ name: 'SDK_ROOT', value: '{dependency:sdk}' }], entriesYaml: '', entries: {}, revision: 'rev' }
  const ready = (names: readonly string[]) => { if (names.some(name => name !== 'sdk')) throw new Error('Missing dependency'); return [] }
  const service = new PluginLibrary({ get: () => ({ ...actor, email: '', groupId: 'admin', admin: true, disabled: false, createdAt: 0, updatedAt: 0 }) },
    { list: () => [row], save: next => { row = next }, remove: () => {} },
    { prepare: async input => ({ ...input, integrity: 'sha512-fixture', artifact: 'fixture', runtimeRevision: 'rev', title: 'Office', description: '', bundlePatch: '[]', dependencies: {} }) }, undefined,
    { impact: () => ({ groups: 0, members: 0 }), revoke: () => {} }, undefined,
    { access: { remove: () => {}, get: () => values }, upstreams: { save: () => {} } }, { ready })
  expect(() => service.setRuntimeDependencies(actor, 'office', ['missing'])).toThrow()
  expect(service.setRuntimeDependencies(actor, 'office', ['sdk']).runtimeDependencies).toEqual(['sdk'])
  expect(() => service.setRuntimeDependencies(actor, 'office', [])).toThrow()
  expect(() => service.setRuntimeDependencies(actor, 'office', ['sdk', 'sdk'])).toThrow()
  service.add(actor, { packageName: 'office', version: '1.0.0' }, true); await service.drain()
  expect(row.runtimeDependencies).toEqual(['sdk'])
  service.replace(actor, { packageName: 'office', version: '2.0.0' }); await service.drain()
  service.select(actor, 'office', service.impact(actor, 'office').revision)
  expect(row.runtimeDependencies).toEqual(['sdk'])
  service.adoptContribution(actor, { packageName: 'office', version: '3.0.0' }, { ...row.current!, version: '3.0.0' }, service.impact(actor, 'office').revision, { id: 'contribution', revision: 'review' }, () => {})
  expect(row.runtimeDependencies).toEqual(['sdk'])
})
