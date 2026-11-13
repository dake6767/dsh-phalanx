import { canonicalJson } from './suite-catalog-document.js'
import {
  disableInstalledServiceBackends,
  installServiceDefinition,
  installedServiceConflict,
  installedServiceView,
  serviceBackendComplete,
  validServiceValue,
} from './installed-services.js'
import type { SuiteCatalogEntry, SuiteCatalogExecutionItem } from './suite-catalog.js'
import { ExecutionFailure, type ExecutionConfiguration, type ExecutionRequest, type SuiteExecutionTemplate } from './platform-execution.js'
import type { CatalogExecutionServiceSlot } from './suite-service-slots.js'

/** These declarations own their fields for every command, including commands without a service. */
export function executionServiceVariables(slots: readonly CatalogExecutionServiceSlot[]): ReadonlySet<string> {
  return new Set(
    slots.flatMap(slot =>
      slot.backends.flatMap(backend => [
        ...backend.fields.map(field => field.name),
        ...(backend.selector?.kind === 'environment' ? [backend.selector.name] : []),
      ]),
    ),
  )
}

function requestedOption(argv: readonly string[], name: string): string | undefined {
  const choices: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const argument = argv[i]!
    if (argument === '--') break
    const separator = argument.indexOf('=')
    const option = separator < 0 ? argument : argument.slice(0, separator)
    if (!option.startsWith('--') || !name.startsWith(option)) continue
    // A delegated parser can accept abbreviations or repeated options. Accept only the unambiguous spelling.
    if (name !== option) return
    const value = separator < 0 ? argv[++i] : argument.slice(separator + 1)
    if (!value || value.startsWith('-')) return
    choices.push(value)
  }
  return choices.length === 1 ? choices[0] : undefined
}

export function executionServiceEnvironment(config: ExecutionConfiguration, request: Pick<ExecutionRequest, 'command' | 'argv'>) {
  const services = config.services
  if (!services || !config.suiteOrigin) return config.variables
  const owned = executionServiceVariables(services.slots)
  const common = config.variables.filter(row => !owned.has(row.name))
  const slot = services.slots.find(row => row.commands.includes(request.command))
  if (common.some(row => !row.value && !config.optionalVariables?.includes(row.name))) throw new ExecutionFailure('not-ready')
  if (!slot) return common
  const selector = slot.backends[0]?.selector
  const choice = selector?.kind === 'option' ? requestedOption(request.argv, selector.name) : undefined
  const backend = slot.backends.find(row => {
    if (selector?.kind === 'option' && (choice === undefined || choice !== row.selector?.value)) return false
    return services.settings.some(setting => setting.slot === slot.id && setting.backend === row.id && setting.enabled)
  })
  const settings = services.settings.find(row => row.slot === slot.id && row.backend === backend?.id)
  if (!backend || !settings) throw new ExecutionFailure('disabled')
  if (!serviceBackendComplete(backend, settings.values)) throw new ExecutionFailure('not-ready')
  return [
    ...common,
    ...backend.fields.flatMap(field =>
      Object.hasOwn(settings.values, field.name) ? [{ name: field.name, value: settings.values[field.name]!, secret: field.type === 'secret' }] : [],
    ),
    ...(backend.selector?.kind === 'environment' ? [{ name: backend.selector.name, value: backend.selector.value, secret: false }] : []),
  ]
}

export function installedCatalogIdentity(entry: SuiteCatalogEntry) {
  return { id: entry.id, version: entry.version, ...(entry.contentHash ? { contentHash: entry.contentHash } : {}) }
}

export function executionServiceDefinition(entry: SuiteCatalogEntry, item: SuiteCatalogExecutionItem) {
  const serviceIdentity = installedCatalogIdentity(entry)
  const services = installServiceDefinition(serviceIdentity, item.serviceSlots)
  return { serviceIdentity, ...(services ? { services } : {}) }
}

export function legacyCatalogExecutionVariables(item: SuiteCatalogExecutionItem) {
  const serviceVariables = executionServiceVariables(item.serviceSlots ?? [])
  return item.variables.filter(row => !serviceVariables.has(row.name))
}

/** Import only values whose field type and single backend make ownership unambiguous. */
export function updateExecutionServiceDefinition(template: SuiteExecutionTemplate, ownerVersion: string, current?: ExecutionConfiguration) {
  const proposed = template.services
  const identity = proposed?.identity ?? (current?.services ? (template.serviceIdentity ?? current.services.identity) : undefined)
  if (!identity) return
  const previous = current?.services?.identity.id === identity.id ? current.services : undefined
  const retired = (current?.variables ?? []).filter(row => row.value && !template.variables.includes(row.name))
  const definition =
    installServiceDefinition(identity, proposed?.slots, previous) ?? (previous && retired.length ? { identity, slots: [], settings: [] } : undefined)
  if (!definition) return
  const settings = new Map(definition.settings.map(row => [JSON.stringify([row.slot, row.backend]), row]))
  if (current && previous) {
    const trustedCommands = (commands: SuiteExecutionTemplate['commands'], slot: CatalogExecutionServiceSlot) =>
      canonicalJson(commands.filter(row => slot.commands.includes(row.command)).toSorted((left, right) => left.command.localeCompare(right.command)))
    const changed = new Set(
      definition.slots.filter(slot => trustedCommands(current.commands, slot) !== trustedCommands(template.commands, slot)).map(slot => slot.id),
    )
    for (const [key, value] of settings) if (changed.has(value.slot)) settings.set(key, { ...value, enabled: false })
  }
  const fields = definition.slots.flatMap(slot => slot.backends.flatMap(backend => backend.fields.map(field => ({ slot, backend, field }))))
  const legacy = new Map(Object.entries(definition.legacyValues ?? {}))
  for (const value of retired) {
    const matches = fields.filter(row => row.field.name === value.name)
    const match = matches.length === 1 ? matches[0] : undefined
    if (match && value.secret === (match.field.type === 'secret') && validServiceValue(match.field.type, value.value)) {
      const { slot, backend } = match
      const key = JSON.stringify([slot.id, backend.id])
      const previousValues = settings.get(key)?.values ?? {}
      if (!Object.hasOwn(previousValues, value.name)) {
        const values = Object.fromEntries([...Object.entries(previousValues), [value.name, value.value]])
        settings.set(key, { slot: slot.id, backend: backend.id, enabled: false, values })
        continue
      }
    }
    const retained = legacy.get(value.name)
    if (retained && retained !== value.value) throw installedServiceConflict()
    legacy.set(value.name, value.value)
  }
  return {
    ...definition,
    ownerVersion,
    settings: [...settings.values()],
    ...(legacy.size ? { legacyValues: Object.fromEntries(legacy) } : {}),
  }
}

export function detachedExecutionConfiguration(configuration: ExecutionConfiguration): ExecutionConfiguration {
  const { suiteOrigin, ...manual } = configuration
  void suiteOrigin
  if (!manual.services) return manual
  return { ...manual, enabled: false, services: disableInstalledServiceBackends(manual.services) }
}

export function executionEnabledForDisplay(configuration: ExecutionConfiguration | undefined): boolean {
  if (!configuration?.enabled) return false
  const services = configuration.suiteOrigin && configuration.services
  if (!services) return true
  const required = configuration.variables.some(row => !row.value && !configuration.optionalVariables?.includes(row.name))
  if (required) return false
  return (
    configuration.commands.some(command => !services.slots.some(slot => slot.commands.includes(command.command))) ||
    installedServiceView(services).slots.some(slot => slot.backends.some(backend => backend.enabled))
  )
}
