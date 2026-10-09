import { expect, it } from 'vitest'
import { PluginAccessAdministration } from '../src/use-cases/plugin-access-administration.js'
import { YamlPluginAccessSyntax } from '../src/adapters/plugin-access-syntax.js'
import type { PluginAccessSettings } from '../src/domain/plugin-access.js'

it('validates access templates, protects platform environment and reports upstream references', () => {
  const actor = { username: 'admin', spaceId: 'admin-space', sessionEpoch: 0 }
  const values: Record<string, PluginAccessSettings> = {}
  let admin = true, entry = 'main'
  const service = new PluginAccessAdministration({ get: () => ({ ...actor, admin, email: '', groupId: 'admins', disabled: false, createdAt: 0, updatedAt: 0 }) },
    { list: () => [{ packageName: 'plugin', version: '1.0.0', current: { packageName: 'plugin', version: '1.0.0', bundlePatch: `- insert:\n  - id: ${entry}\n    name: plugin\n`, title: '', description: '', integrity: '', runtimeRevision: '', artifact: '', dependencies: {} }, stage: 'available', published: true }] },
    { get: name => values[name], list: () => values, save: (name, row) => { values[name] = { ...row, revision: 'rev' } }, remove: name => { delete values[name] } },
    { list: () => [{ name: 'search', baseUrl: 'https://example.test', credential: 'private-key', headers: [] }] }, new YamlPluginAccessSyntax())
  const save = (entriesYaml: string, environment = [{ name: 'DSH_IMAGE_GEN_KEY', value: '{access-token}' }]) => service.save(actor, 'plugin', { entriesYaml, environment })
  for (const yaml of ['main: !!js evil()', 'main: !unknown {}', 'main: [one]', 'missing: {}', 'main: {baseURL: "{upstream:missing}"}', 'main: {value: {__jsExpr: evil}}', 'main: &ref {value: *ref}']) expect(() => save(yaml)).toThrow()
  for (const name of ['HOME', 'DSH_HOME', 'DSH_PHALANX_NEW', 'LC_TIME', 'https_proxy', 'ALL_PROXY', 'BAD-NAME']) expect(() => save('', [{ name, value: 'bad' }])).toThrow()
  values.other = { environment: [{ name: 'CONFLICT', value: '' }], entriesYaml: '', entries: {}, revision: 'other' }
  expect(() => save('', [{ name: 'CONFLICT', value: '' }])).toThrow()
  expect(() => save('', [{ name: 'DUP', value: '1' }, { name: 'DUP', value: '2' }])).toThrow()
  const view = save('main:\n  baseURL: "{upstream:search}"\n  tools: {ask: true}\n')
  expect(view.configured).toBe(true); expect(view.entryIds).toEqual(['main']); expect(view.invalidEntryIds).toEqual([])
  expect(service.references('plugin', 'search')).toEqual(['entries.main.baseURL'])
  expect(JSON.stringify(view)).not.toContain('private-key')
  entry = 'replacement'; expect(service.view(actor, 'plugin').invalidEntryIds).toEqual(['main']); expect(service.summary('plugin').invalidAccessEntries).toEqual(['main'])
  expect(values.plugin?.entries).toHaveProperty('main'); entry = 'main'
  admin = false; expect(() => service.view(actor, 'plugin')).toThrow()
  admin = true; expect(save('', []).configured).toBe(false)
})
