import { canonicalJson } from './suite-catalog-document.js'
import { BusinessRuleError } from './business-error.js'
import type { CatalogExecutionServiceSlot, CatalogPluginServiceSlot, CatalogServiceBackend } from './suite-service-slots.js'

export type InstalledServiceOwner = { readonly kind: 'execution' | 'plugin'; readonly name: string }
export type InstalledServiceSlot = CatalogExecutionServiceSlot | CatalogPluginServiceSlot
export interface InstalledServiceIdentity {
  readonly id: string
  readonly version: string
  readonly contentHash?: string
}
export interface InstalledServiceSettings {
  readonly slot: string
  readonly backend: string
  readonly enabled: boolean
  readonly values: Readonly<Record<string, string>>
}
export interface InstalledServices<Slot extends InstalledServiceSlot = InstalledServiceSlot> {
  readonly identity: InstalledServiceIdentity
  readonly ownerVersion?: string
  readonly slots: readonly Slot[]
  readonly settings: readonly InstalledServiceSettings[]
  readonly legacyValues?: Readonly<Record<string, string>>
}

export type InstalledServiceChange =
  | { readonly action: 'discard-legacy'; readonly field: string; readonly confirmed: true }
  | ({ readonly slot: string; readonly backend: string } & (
      | { readonly action: 'save'; readonly values: Readonly<Record<string, string>> }
      | { readonly action: 'enable' | 'disable' }
      | { readonly action: 'clear' | 'adopt-legacy'; readonly field: string; readonly confirmed: true }
    ))

const invalid = () => new BusinessRuleError('invalid', 'Check the service backend and its configuration.', 'execution-config-invalid')
export const installedServiceConflict = () =>
  new BusinessRuleError('conflict', 'Platform configuration changed. Reload before saving.', 'platform-configuration-conflict')
export function serviceBackendComplete(backend: CatalogServiceBackend, values: InstalledServiceSettings['values']): boolean {
  const configured = (name: string) => Object.hasOwn(values, name) && Boolean(values[name])
  const configuredGroups = new Set(backend.fields.filter(field => field.requiredGroup && configured(field.name)).map(field => field.requiredGroup))
  return backend.fields.every(field => (!field.required || configured(field.name)) && (!field.requiredGroup || configuredGroups.has(field.requiredGroup)))
}

export function validServiceValue(type: CatalogServiceBackend['fields'][number]['type'], value: string): boolean {
  if (value.length > (type === 'secret' ? 65_536 : 4096) || /\p{Cc}/u.test(value)) return false
  if (type !== 'url' || value === '') return true
  try {
    const url = new URL(value)
    return /^(http|https):$/u.test(url.protocol) && !url.username && !url.password && !url.hash
  } catch {
    return false
  }
}

function serviceProjection(slot: InstalledServiceSlot, backend: CatalogServiceBackend) {
  const { label, ...fields } = backend
  void label
  return canonicalJson({ slot: 'binding' in slot ? slot.binding : [...slot.commands].sort(), backend: fields })
}

export function installServiceDefinition<Slot extends InstalledServiceSlot>(
  identity: InstalledServiceIdentity,
  slots: readonly Slot[] | undefined,
  previous?: InstalledServices<Slot>,
): InstalledServices<Slot> | undefined {
  if (previous?.identity.id !== identity.id) previous = undefined
  for (const setting of previous?.settings ?? []) {
    const before = previous?.slots.find(row => row.id === setting.slot)?.backends.find(row => row.id === setting.backend)
    const after = slots?.find(row => row.id === setting.slot)?.backends.find(row => row.id === setting.backend)
    if (
      Object.entries(setting.values).some(
        ([name, value]) =>
          value && !after?.fields.some(field => field.name === name && before?.fields.some(old => old.name === name && old.type === field.type)),
      )
    )
      throw new BusinessRuleError('conflict', 'Clear the configuration fields removed by this update before retrying.', 'platform-configuration-conflict')
  }
  if (!slots?.length && !previous?.legacyValues) return
  const definitions = slots ?? []
  const settings = definitions.flatMap(slot =>
    slot.backends.flatMap(backend => {
      const old = previous?.settings.find(row => row.slot === slot.id && row.backend === backend.id)
      const oldSlot = previous?.slots.find(row => row.id === slot.id)
      const oldBackend = oldSlot?.backends.find(row => row.id === backend.id)
      if (!old || !oldSlot || !oldBackend) return []
      const values = Object.fromEntries(
        backend.fields.flatMap(field => {
          const value = Object.hasOwn(old.values, field.name) ? old.values[field.name] : undefined
          return value !== undefined &&
            oldBackend.fields.some(row => row.name === field.name && row.type === field.type) &&
            validServiceValue(field.type, value)
            ? [[field.name, value]]
            : []
        }),
      )
      // An explicit update may change the mapping even if the field names are unchanged.
      const unchanged = serviceProjection(oldSlot, oldBackend) === serviceProjection(slot, backend)
      return [{ ...old, values, enabled: old.enabled && unchanged && serviceBackendComplete(backend, values) }]
    }),
  )
  return { identity, slots: definitions, settings, ...(previous?.legacyValues ? { legacyValues: previous.legacyValues } : {}) }
}

export function configureServiceBackend<Slot extends InstalledServiceSlot>(state: InstalledServices<Slot>, input: unknown): InstalledServices<Slot> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalid()
  const change = input as Record<string, unknown>
  if (change.action === 'discard-legacy') {
    const { legacyValues, ...definition } = state
    if (
      !legacyValues ||
      typeof change.field !== 'string' ||
      !Object.hasOwn(legacyValues, change.field) ||
      change.confirmed !== true ||
      Object.keys(change).length !== 3
    )
      throw invalid()
    const retained = Object.entries(legacyValues).filter(([name]) => name !== change.field)
    return { ...definition, ...(retained.length ? { legacyValues: Object.fromEntries(retained) } : {}) }
  }
  const slot = state.slots.find(row => row.id === change.slot),
    backend = slot?.backends.find(row => row.id === change.backend)
  if (!slot || !backend) throw invalid()
  const before = state.settings.find(row => row.slot === slot.id && row.backend === backend.id)
  const values: Record<string, string> = Object.assign(Object.create(null), before?.values)
  let enabled = before?.enabled === true && serviceBackendComplete(backend, values)
  const legacyValues = new Map(Object.entries(state.legacyValues ?? {}))
  const size = Object.keys(change).length
  switch (change.action) {
    case 'save':
      if (size !== 4 || !change.values || typeof change.values !== 'object' || Array.isArray(change.values)) throw invalid()
      for (const [name, raw] of Object.entries(change.values)) {
        const field = backend.fields.find(row => row.name === name)
        if (!field || typeof raw !== 'string') throw invalid()
        const value = field.type === 'secret' ? raw : raw.trim()
        if (!validServiceValue(field.type, value) || (value && !value.trim())) throw invalid()
        if (field.type === 'secret' && !value) continue
        if (value) values[name] = value
        else delete values[name]
      }
      enabled &&= serviceBackendComplete(backend, values)
      break
    case 'clear':
    case 'adopt-legacy': {
      if (size !== 5 || change.confirmed !== true) throw invalid()
      const field = backend.fields.find(row => row.name === change.field && row.type === 'secret')
      if (!field) throw invalid()
      if (change.action === 'clear') {
        delete values[field.name]
        enabled = false
      } else {
        const retained = legacyValues.get(field.name)
        if (!retained || !validServiceValue('secret', retained)) throw invalid()
        values[field.name] = retained
        const unconfiguredTarget = state.slots.some(otherSlot =>
          otherSlot.backends.some(otherBackend => {
            if (otherSlot.id === slot.id && otherBackend.id === backend.id) return false
            if (!otherBackend.fields.some(candidate => candidate.name === field.name && candidate.type === 'secret')) return false
            return !state.settings.find(row => row.slot === otherSlot.id && row.backend === otherBackend.id)?.values[field.name]
          }),
        )
        if (!unconfiguredTarget) legacyValues.delete(field.name)
      }
      break
    }
    case 'enable':
      if (size !== 3 || !serviceBackendComplete(backend, values)) throw invalid()
      enabled = true
      break
    case 'disable':
      if (size !== 3) throw invalid()
      enabled = false
      break
    default:
      throw invalid()
  }
  const exclusive = change.action === 'enable' && ('binding' in slot || ('selector' in backend && backend.selector?.kind === 'environment'))
  const { legacyValues: previousLegacy, ...configuration } = state
  void previousLegacy
  return {
    ...configuration,
    ...(legacyValues.size ? { legacyValues: Object.fromEntries(legacyValues) } : {}),
    settings: [
      ...state.settings.filter(row => row !== before).map(row => (exclusive && row.slot === slot.id ? { ...row, enabled: false } : row)),
      { slot: slot.id, backend: backend.id, enabled, values: Object.fromEntries(Object.entries(values)) },
    ],
  }
}

export function installedServiceView(state: InstalledServices) {
  return {
    identity: state.identity,
    ...(state.legacyValues
      ? {
          retainedLegacyFields: Object.entries(state.legacyValues)
            .filter(([, value]) => value)
            .map(([name]) => name),
        }
      : {}),
    slots: state.slots.map(slot => ({
      id: slot.id,
      label: slot.label,
      backends: slot.backends.map(backend => {
        const settings = state.settings.find(row => row.slot === slot.id && row.backend === backend.id)
        const values = settings?.values ?? {}
        return {
          id: backend.id,
          label: backend.label,
          enabled: settings?.enabled === true && serviceBackendComplete(backend, values),
          complete: serviceBackendComplete(backend, values),
          fields: backend.fields.map(field => ({
            ...field,
            configured: Object.hasOwn(values, field.name) && Boolean(values[field.name]),
            ...(field.type === 'secret' ? {} : { value: Object.hasOwn(values, field.name) ? values[field.name]! : '' }),
          })),
        }
      }),
    })),
  }
}

/** Metadata keeps blank references. Storage supplies the field-bound value only at the encryption seam. */
export function mapInstalledServiceSecrets<Slot extends InstalledServiceSlot>(
  state: InstalledServices<Slot>,
  visit: (key: string, value: string) => string,
): InstalledServices<Slot> {
  return {
    ...state,
    ...(state.legacyValues
      ? { legacyValues: Object.fromEntries(Object.entries(state.legacyValues).map(([name, value]) => [name, visit(JSON.stringify([null, name]), value)])) }
      : {}),
    settings: state.settings.map(setting => {
      const fields = state.slots.find(row => row.id === setting.slot)?.backends.find(row => row.id === setting.backend)?.fields ?? []
      const values = Object.fromEntries(
        fields.flatMap(field => {
          if (!Object.hasOwn(setting.values, field.name)) return []
          const value = setting.values[field.name]!
          return [[field.name, field.type === 'secret' ? visit(JSON.stringify([setting.slot, setting.backend, field.name]), value) : value]]
        }),
      )
      return { ...setting, values }
    }),
  }
}

export function disableInstalledServiceBackends<Slot extends InstalledServiceSlot>(state: InstalledServices<Slot>): InstalledServices<Slot> {
  return { ...state, settings: state.settings.map(row => ({ ...row, enabled: false })) }
}

export function resetInstalledServiceBackends<Slot extends InstalledServiceSlot>(state: InstalledServices<Slot>): InstalledServices<Slot> {
  return {
    ...state,
    settings: state.settings.map(row => {
      const backend = state.slots.find(slot => slot.id === row.slot)?.backends.find(backend => backend.id === row.backend)
      return backend?.fields.some(field => field.type === 'secret' && Object.hasOwn(row.values, field.name)) ? { ...row, enabled: false } : row
    }),
  }
}
