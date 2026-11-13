import { BusinessRuleError } from './business-error.js'
import { executionLongOption, executionOptionBlocked } from './execution-command-line.js'
import { executionConfiguration } from './execution-configuration.js'
import type { SuiteCatalogExecutionItem } from './suite-catalog.js'

export interface CatalogServiceField {
  readonly name: string
  readonly type: 'text' | 'url' | 'secret'
  readonly required: boolean
  readonly requiredGroup?: string
}
type Label = Readonly<Record<'en' | 'zh-CN', string>>

export interface CatalogServiceBackend {
  readonly id: string
  readonly label: Label
  readonly fields: readonly CatalogServiceField[]
}
interface ExecutionBackend extends CatalogServiceBackend {
  readonly selector?: { readonly kind: 'environment' | 'option'; readonly name: string; readonly value: string }
}
export interface CatalogExecutionServiceSlot {
  readonly id: string
  readonly label: Label
  readonly commands: readonly string[]
  readonly backends: readonly ExecutionBackend[]
}

const object = (value: unknown, keys: readonly string[]): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) && Object.keys(value).every(key => keys.includes(key))
const identifier = (value: unknown): value is string => typeof value === 'string' && /^[a-z][a-z0-9-]{0,63}$/u.exec(value)?.[0] === value
const list = (value: unknown, limit: number): value is readonly unknown[] => Array.isArray(value) && value.length > 0 && value.length <= limit
const label = (value: unknown): value is Label =>
  object(value, ['en', 'zh-CN']) &&
  [value.en, value['zh-CN']].every(text => typeof text === 'string' && text.trim().length > 0 && text.length <= 160 && !/\p{Cc}/u.test(text))

function readField(value: unknown): CatalogServiceField | undefined {
  if (!object(value, ['name', 'type', 'required', 'requiredGroup'])) return
  const { name, type, required, requiredGroup } = value
  if (typeof name !== 'string' || (type !== 'text' && type !== 'url' && type !== 'secret') || typeof required !== 'boolean') return
  if (requiredGroup !== undefined && (!identifier(requiredGroup) || required || type !== 'secret')) return
  return { name, type, required, ...(requiredGroup === undefined ? {} : { requiredGroup }) }
}

function readBackend(value: unknown, names: ReadonlySet<string>): ExecutionBackend | undefined {
  if (!object(value, ['id', 'label', 'fields', 'selector']) || !identifier(value.id) || !label(value.label) || !list(value.fields, 64)) return
  const fields: CatalogServiceField[] = []
  for (const raw of value.fields) {
    const field = readField(raw)
    if (!field || !names.has(field.name) || fields.some(other => other.name === field.name)) return
    fields.push(field)
  }
  const groups = fields.flatMap(field => (field.requiredGroup ? [field.requiredGroup] : []))
  if ((!fields.some(field => field.required) && !groups.length) || groups.some(group => groups.indexOf(group) === groups.lastIndexOf(group))) return
  const backend = { id: value.id, label: value.label, fields }
  if (value.selector === undefined) return backend
  if (!object(value.selector, ['kind', 'name', 'value'])) return
  const { kind, name, value: selected } = value.selector
  if ((kind !== 'environment' && kind !== 'option') || typeof name !== 'string' || name.trim() !== name || !identifier(selected)) return
  if (kind === 'environment' ? !names.has(name) : !executionLongOption(name)) return
  return { ...backend, selector: { kind, name, value: selected } }
}

/** Signed backend definitions can only refer to the owning execution item's existing capabilities. */
export function readExecutionServiceSlots(item: SuiteCatalogExecutionItem, value: unknown): readonly CatalogExecutionServiceSlot[] | undefined {
  if (!list(value, 16)) return
  try {
    executionConfiguration({
      enabled: false,
      commands: item.delegated,
      variables: item.variables.map(({ name }) => ({ name, secret: true })),
    })
  } catch (error) {
    if (error instanceof BusinessRuleError) return
    throw error
  }
  const names = new Set(item.variables.map(variable => variable.name))
  const commands = new Set(item.delegated.map(command => command.command))
  const slots: CatalogExecutionServiceSlot[] = []
  for (const raw of value) {
    if (!object(raw, ['id', 'label', 'commands', 'backends']) || !identifier(raw.id) || !label(raw.label) || !list(raw.commands, 32) || !list(raw.backends, 32))
      return
    if (slots.some(slot => slot.id === raw.id)) return
    const delegated: string[] = []
    for (const command of raw.commands) {
      if (typeof command !== 'string' || !commands.delete(command)) return
      delegated.push(command)
    }
    const backends: ExecutionBackend[] = []
    for (const definition of raw.backends) {
      const backend = readBackend(definition, names)
      if (!backend || backends.some(other => other.id === backend.id)) return
      backends.push(backend)
    }
    if (
      !validBackendSelection(
        backends,
        item.delegated.filter(command => delegated.includes(command.command)),
      )
    )
      return
    slots.push({ id: raw.id, label: raw.label, commands: delegated, backends })
  }
  const backends = slots.flatMap(slot => slot.backends)
  const selectors = new Set(backends.flatMap(backend => (backend.selector?.kind === 'environment' ? [backend.selector.name] : [])))
  const fieldTypes = new Map<string, CatalogServiceField['type']>()
  for (const field of backends.flatMap(backend => backend.fields)) {
    if (selectors.has(field.name) || (fieldTypes.has(field.name) && fieldTypes.get(field.name) !== field.type)) return
    fieldTypes.set(field.name, field.type)
  }
  return slots
}

function validBackendSelection(backends: readonly ExecutionBackend[], commands: SuiteCatalogExecutionItem['delegated']): boolean {
  const selector = backends[0]?.selector
  if (!selector) return backends.length === 1
  if (selector.kind === 'option' && commands.some(command => executionOptionBlocked([selector.name], command.blockedOptions ?? []))) return false
  const values = new Set<string>()
  for (const backend of backends) {
    const choice = backend.selector
    if (choice?.kind !== selector.kind || choice.name !== selector.name || values.has(choice.value)) return false
    values.add(choice.value)
  }
  return true
}

export interface CatalogPluginServiceSlot {
  readonly id: string
  readonly label: Label
  /** Paths are within data returned by the service's revisioned load/save methods. */
  readonly binding: CatalogPluginServiceBinding
  readonly backends: readonly PluginBackend[]
}
interface CatalogPluginServiceBinding {
  readonly kind: 'revisioned-rpc'
  readonly service: string
  readonly active: readonly string[]
  readonly selection: readonly string[]
  readonly profiles: readonly string[]
  readonly idKey: string
  readonly snapshotKey: string
  readonly fields: { readonly endpoint: string; readonly key: string; readonly model: string; readonly mode: string; readonly enabled?: string }
  readonly empty?: Readonly<Record<string, string | boolean>>
  readonly maxProfiles?: number
}
interface PluginBackend extends CatalogServiceBackend {
  readonly protocol: 'openai-chat' | 'openai-image' | 'seedream-image'
  readonly mode: string
  readonly upstream: { readonly endpoint: string; readonly key: string; readonly model: string }
  readonly profile?: Readonly<Record<string, string | boolean>>
}

const dataKey = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,63}$/u.exec(value)?.[0] === value && value !== 'constructor' && value !== 'prototype'
const dataPath = (value: unknown): value is readonly string[] => list(value, 8) && value.every(dataKey)

function readPluginBinding(value: unknown): CatalogPluginServiceBinding | undefined {
  if (!object(value, ['kind', 'service', 'active', 'selection', 'profiles', 'idKey', 'snapshotKey', 'fields', 'empty', 'maxProfiles'])) return
  const { kind, service, active, selection, profiles, idKey, snapshotKey, fields, empty, maxProfiles } = value
  if (kind !== 'revisioned-rpc' || !dataKey(service) || !dataPath(active) || !dataPath(selection) || !dataPath(profiles)) return
  if (!dataKey(idKey) || !dataKey(snapshotKey) || idKey === snapshotKey || !object(fields, ['endpoint', 'key', 'model', 'mode', 'enabled'])) return
  const { endpoint, key, model, mode, enabled } = fields
  if (!dataKey(endpoint) || !dataKey(key) || !dataKey(model) || !dataKey(mode) || (enabled !== undefined && !dataKey(enabled))) return
  if (new Set(Object.values(fields)).size !== Object.keys(fields).length) return
  if (maxProfiles !== undefined && (typeof maxProfiles !== 'number' || !Number.isSafeInteger(maxProfiles) || maxProfiles < 1 || maxProfiles > 1000)) return
  const binding = {
    kind,
    service,
    active,
    selection,
    profiles,
    idKey,
    snapshotKey,
    fields: { endpoint, key, model, mode, ...(enabled ? { enabled } : {}) },
    ...(maxProfiles === undefined ? {} : { maxProfiles }),
  } as const
  if (empty === undefined) return binding
  const defaults = readPluginProfile(empty)
  return defaults && (!Object.hasOwn(defaults, key) || defaults[key] === '') ? { ...binding, empty: defaults } : undefined
}

function readPluginBackend(value: unknown): PluginBackend | undefined {
  if (!object(value, ['id', 'label', 'fields', 'protocol', 'mode', 'upstream', 'profile'])) return
  const { id, label: title, fields: values, protocol, mode, upstream, profile } = value
  if (!identifier(id) || !label(title) || !list(values, 64) || !identifier(mode)) return
  if (protocol !== 'openai-chat' && protocol !== 'openai-image' && protocol !== 'seedream-image') return
  if (!object(upstream, ['endpoint', 'key', 'model'])) return
  const { endpoint, key, model } = upstream
  if (!dataKey(endpoint) || !dataKey(key) || !dataKey(model)) return
  const fields: CatalogServiceField[] = []
  for (const raw of values) {
    const field = readField(raw)
    if (!field || field.requiredGroup || !dataKey(field.name) || fields.some(other => other.name === field.name)) return
    fields.push(field)
  }
  const mapsRequired = (name: string, type: CatalogServiceField['type']) => fields.some(field => field.name === name && field.type === type && field.required)
  if (!mapsRequired(endpoint, 'url') || !mapsRequired(key, 'secret') || !mapsRequired(model, 'text')) return
  const result = { id, label: title, fields, protocol, mode, upstream: { endpoint, key, model } } as const
  if (profile === undefined) return result
  const settings = readPluginProfile(profile)
  return settings ? { ...result, profile: settings } : undefined
}

function readPluginProfile(input: unknown): Readonly<Record<string, string | boolean>> | undefined {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return
  const entries = Object.entries(input)
  if (entries.length < 1 || entries.length > 16) return
  if (
    entries.some(
      ([name, setting]) => !dataKey(name) || (typeof setting !== 'boolean' && (typeof setting !== 'string' || setting.length > 160 || /\p{Cc}/u.test(setting))),
    )
  )
    return
  return Object.fromEntries(entries)
}

/** Plugin declarations may map data owned by one revisioned settings service. */
export function readPluginServiceSlots(value: unknown): readonly CatalogPluginServiceSlot[] | undefined {
  if (!list(value, 16)) return
  const slots: CatalogPluginServiceSlot[] = []
  const writes = new Set<string>()
  for (const raw of value) {
    if (!object(raw, ['id', 'label', 'binding', 'backends']) || !identifier(raw.id) || !label(raw.label) || !list(raw.backends, 16)) return
    const binding = readPluginBinding(raw.binding)
    if (!binding || slots.some(slot => slot.id === raw.id)) return
    const backends: PluginBackend[] = []
    const fieldKeys = new Set(Object.values(binding.fields))
    const profileKeys = new Set<string>()
    for (const definition of raw.backends) {
      const backend = readPluginBackend(definition)
      if (!backend || backends.some(other => other.id === backend.id || other.mode === backend.mode)) return
      if (backends.some(other => (other.protocol === 'openai-chat') !== (backend.protocol === 'openai-chat'))) return
      for (const name of Object.keys(backend.profile ?? {})) {
        if (fieldKeys.has(name)) return
        profileKeys.add(name)
      }
      backends.push(backend)
    }
    if (Object.keys(binding.empty ?? {}).some(key => !fieldKeys.has(key) && !profileKeys.has(key))) return
    const paths = [binding.selection, binding.profiles, ...[...fieldKeys, ...profileKeys].map(key => [...binding.active, key])]
    for (const path of paths) {
      const absolute = [binding.service, ...path].join('.')
      if ([...writes].some(other => other === absolute || other.startsWith(absolute + '.') || absolute.startsWith(other + '.'))) return
      writes.add(absolute)
    }
    slots.push({ id: raw.id, label: raw.label, binding, backends })
  }
  return slots
}
