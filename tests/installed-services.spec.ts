import { expect, it } from 'vitest'
import {
  configureServiceBackend,
  installServiceDefinition,
  installedServiceView,
  mapInstalledServiceSecrets,
  resetInstalledServiceBackends,
} from '../src/domain/installed-services.js'
import { executionServiceEnvironment } from '../src/domain/execution-service-environment.js'
import { readExecutionServiceSlots, type CatalogExecutionServiceSlot } from '../src/domain/suite-service-slots.js'

const label = { en: 'Image', 'zh-CN': '生图' }
const slots: readonly CatalogExecutionServiceSlot[] = [
  {
    id: 'image',
    label,
    commands: ['draw'],
    backends: ['first', 'second'].map(id => ({
      id,
      label,
      selector: { kind: 'option', name: '--provider', value: id },
      fields: [
        { name: 'ENDPOINT', type: 'url', required: false },
        { name: 'TOKEN', type: 'secret', required: true },
      ],
    })),
  },
]

it('maintains independently scoped credentials and requires explicit activation and confirmed clearing', () => {
  const empty = installServiceDefinition({ id: 'design', version: '1.0.0' }, slots)!
  const apply = (state: typeof empty, backend: string, action: Record<string, unknown>) => configureServiceBackend(state, { slot: 'image', backend, ...action })
  let state = apply(empty, 'first', { action: 'save', values: { ENDPOINT: 'https://first.example/api' } })
  expect(installedServiceView(state).slots[0]?.backends[0]).toMatchObject({ complete: false, enabled: false })
  expect(() => apply(state, 'first', { action: 'enable' })).toThrow()
  state = apply(state, 'first', { action: 'save', values: { TOKEN: 'fictional-first' } })
  state = apply(state, 'second', { action: 'save', values: { TOKEN: 'fictional-second' } })
  state = apply(state, 'first', { action: 'enable' })
  state = apply(state, 'first', { action: 'disable' })
  state = apply(state, 'first', { action: 'save', values: { TOKEN: '' } })
  expect(state.settings.find(row => row.backend === 'first')).toMatchObject({ enabled: false, values: { TOKEN: 'fictional-first' } })
  expect(() => apply(state, 'first', { action: 'clear', field: 'TOKEN', confirmed: false })).toThrow()
  state = apply(state, 'first', { action: 'clear', field: 'TOKEN', confirmed: true })
  const view = installedServiceView(state)
  expect(view.slots[0]?.backends).toMatchObject([{ complete: false }, { complete: true, enabled: false }])
  expect(JSON.stringify(view)).not.toContain('fictional-')
  expect(JSON.stringify(view)).toContain('https://first.example/api')
})

it('preserves matching backend settings on label changes and refuses to delete configured fields during an update', () => {
  const installed = installServiceDefinition({ id: 'design', version: '1.0.0' }, slots)!
  const configured = configureServiceBackend(installed, { slot: 'image', backend: 'first', action: 'save', values: { TOKEN: 'private' } })
  const enabled = configureServiceBackend(configured, { slot: 'image', backend: 'first', action: 'enable' })
  const renamed = slots.map(slot => ({ ...slot, label: { ...slot.label, en: 'Renamed' } }))
  const updated = installServiceDefinition({ id: 'design', version: '2.0.0' }, renamed, enabled)
  expect(updated?.settings[0]).toMatchObject({ enabled: true, values: { TOKEN: 'private' } })
  expect(installServiceDefinition({ id: 'other', version: '2.0.0' }, renamed, enabled)?.settings).toEqual([])
  expect(() => installServiceDefinition({ id: 'design', version: '2.0.0' }, undefined, enabled)).toThrow()
})

it('requires explicit activation after protected key reset and replacement', () => {
  const installed = installServiceDefinition({ id: 'design', version: '1.0.0' }, slots)!
  const target = { slot: 'image', backend: 'first' }
  const configured = configureServiceBackend(installed, { ...target, action: 'save', values: { TOKEN: 'fixture', ENDPOINT: 'https://example.test' } })
  const enabled = configureServiceBackend(configured, { ...target, action: 'enable' })
  const reset = resetInstalledServiceBackends(mapInstalledServiceSecrets(enabled, () => ''))
  const replacement = configureServiceBackend(reset, { ...target, action: 'save', values: { TOKEN: 'replacement' } })
  expect(installedServiceView(replacement).slots[0]?.backends[0]).toMatchObject({ complete: true, enabled: false })
})

it('enables and runs a backend with only a retained alternative credential', () => {
  const primary = { name: 'PROVIDER_KEY', type: 'secret', required: false, requiredGroup: 'key' }
  const alias = { ...primary, name: 'ALTERNATE_KEY' }
  const declaration = [{ id: 'image', label, commands: ['draw'], backends: [{ id: 'provider', label, fields: [primary, alias] }] }]
  const execution = {
    kind: 'execution' as const,
    skill: 'design',
    runtimeDependency: 'tools',
    delegated: [{ command: 'draw', blocked: [] }],
    variables: [primary, alias].map(field => ({ name: field.name, purpose: label })),
  }
  const parsed = readExecutionServiceSlots(execution, declaration)!
  expect(parsed).toEqual(declaration)
  expect(readExecutionServiceSlots(execution, [{ ...declaration[0], backends: [{ id: 'provider', label, fields: [primary] }] }])).toBeUndefined()
  const target = { slot: 'image', backend: 'provider' }
  const installed = installServiceDefinition({ id: 'design', version: '1.0.0' }, parsed)!
  const retained = { ...installed, legacyValues: { ALTERNATE_KEY: 'fixture-alias' } }
  expect(() => configureServiceBackend(retained, { ...target, action: 'enable' })).toThrow()
  const adopted = configureServiceBackend(retained, { ...target, action: 'adopt-legacy', field: alias.name, confirmed: true })
  const enabled = configureServiceBackend(adopted, { ...target, action: 'enable' })
  const view = installedServiceView(enabled)
  expect(view.slots[0]?.backends[0]).toMatchObject({ enabled: true, complete: true })
  expect(JSON.stringify(view)).not.toContain('fixture-alias')
  expect(
    executionServiceEnvironment(
      {
        enabled: true,
        suiteOrigin: 'suite:design',
        commands: execution.delegated,
        variables: [],
        services: enabled,
      },
      { command: 'draw', argv: [] },
    ),
  ).toEqual([{ name: alias.name, value: 'fixture-alias', secret: true }])
})
