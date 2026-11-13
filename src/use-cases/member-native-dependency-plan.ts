import { posix } from 'node:path'
import { BusinessRuleError } from '../domain/business-error.js'
import type { NativePluginDependencyPlans } from '../domain/plugin-preinstall.js'
import type { RuntimeDependencyVersion } from '../domain/runtime-dependency.js'

type ScopedCommand = { readonly command: string; readonly version: RuntimeDependencyVersion; readonly path: string }
const commandIdentity = (entry: ScopedCommand) => JSON.stringify([entry.version.id, entry.path])

/** Locked commands use the member's existing PATH projection and never become globally registered commands. */
export function planNativeDependencyCommands(
  packages: NativePluginDependencyPlans,
  base: ReadonlyMap<string, RuntimeDependencyVersion>,
  ready: (names: readonly string[]) => readonly RuntimeDependencyVersion[],
  additional: readonly RuntimeDependencyVersion[] = [],
) {
  const blocked = new Set<string>()
  const plans = new Map<string, { versions: ReadonlyMap<string, RuntimeDependencyVersion>; commands: readonly ScopedCommand[] }>()
  const claims = new Map<string, Map<string, Set<string>>>()
  const claim = (entry: ScopedCommand, owner?: string) => {
    const found = claims.get(entry.command) ?? new Map<string, Set<string>>()
    const identity = commandIdentity(entry)
    const names = found.get(identity) ?? new Set<string>()
    if (owner) names.add(owner)
    found.set(identity, names)
    claims.set(entry.command, found)
  }
  const ordinary = [...base.values(), ...additional]
  for (const version of ordinary) for (const command of version.commands) claim({ command, version, path: version.commandPaths[command]! })
  for (const [name, plan] of Object.entries(packages)) {
    try {
      const declarations = [...new Set(plan.dependencies)]
      const selected = ready(declarations)
      const versions = new Map(declarations.map((dependency, index) => [dependency, selected[index]!]))
      const commands = (plan.resources ?? []).flatMap(binding => {
        if (binding.kind !== 'command-path') return []
        const version = versions.get(binding.runtimeDependency)
        if (!version?.isolated || version.python)
          throw new BusinessRuleError('conflict', 'The locked plugin command resource is unavailable.', 'runtime-dependency-unavailable')
        return binding.commands.map(command => ({ command, version, path: posix.join(binding.path, command) }))
      })
      plans.set(name, { versions, commands })
      for (const entry of commands) claim(entry, name)
    } catch (error) {
      if (!(error instanceof BusinessRuleError)) throw error
      blocked.add(name)
    }
  }
  for (const identities of claims.values()) {
    if (identities.size < 2) continue
    for (const names of identities.values()) for (const name of names) blocked.add(name)
  }

  const bindings = new Map(base)
  const projected = new Map<string, Record<string, string>>()
  const globalCommands = new Set(ordinary.flatMap(version => version.commands))
  for (const [name, plan] of plans) {
    if (blocked.has(name)) continue
    for (const [dependency, version] of plan.versions) bindings.set(dependency, version)
    for (const { command, version, path } of plan.commands) {
      if (globalCommands.has(command)) continue
      const paths = projected.get(version.id) ?? (Object.create(null) as Record<string, string>)
      paths[command] = path
      projected.set(version.id, paths)
    }
  }
  for (const [dependency, version] of bindings) {
    const paths = projected.get(version.id)
    if (paths) bindings.set(dependency, { ...version, nativeCommandPaths: Object.fromEntries(Object.entries(paths).sort(([a], [b]) => a.localeCompare(b))) })
  }
  return { bindings, blocked: [...blocked] }
}
