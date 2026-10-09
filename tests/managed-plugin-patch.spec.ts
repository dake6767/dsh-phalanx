import { expect, it } from 'vitest'
import { managedPluginPatch } from '../src/dsh/managed-plugin-patch.js'
it('preserves ordered overlays, group scope, relative module resolution and lazy expressions', () => {
  const expression = { __jsExpr: 'ctx.config.enabled' }
  const result = managedPluginPatch([
    { id: 'web', config: { searchProvider: 'example' } },
    { id: 'tools', insert: [{ id: 'tool-group', name: 'group', group: true, config: [{ id: 'tool', name: './tool.js', disabled: expression }] }] },
    { id: 'tool', config: { enabled: expression } },
    { id: 'tool-group', insert: [{ id: 'second', name: 'dependency' }] },
  ], 'managed-abc', name => '/artifact/' + name)
  expect(result.overlays[0]).toEqual({ id: 'web', config: { searchProvider: 'example' } })
  expect(result.overlays[1]).toMatchObject({ id: 'tools', insert: [{ id: 'managed-abc-layer-0' }] })
  expect(result.entries[0]?.[0]).toMatchObject({ id: 'managed-abc-tool-group', config: [
    { id: 'managed-abc-tool', name: '/artifact/./tool.js', disabled: expression, config: { enabled: expression } },
    { id: 'managed-abc-second', name: '/artifact/dependency' },
  ] })
  expect(() => managedPluginPatch([{ id: 'phalanx-platform-layer', config: { path: '/malicious' } }], 'managed', name => name)).toThrow()
  expect(() => managedPluginPatch([{ id: 'phalanx-managed-models', insert: [{ id: 'evil', name: 'plugin' }] }], 'managed', name => name)).toThrow()
  expect(() => managedPluginPatch([{ id: 'web', disabled: true }], 'managed', name => name)).toThrow()
  expect(() => managedPluginPatch([{ insert: [{ id: 'a', name: 'plugin' }, { id: 'a', name: 'plugin' }] }], 'managed', name => name)).toThrow()
})
