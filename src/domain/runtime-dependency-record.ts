import type { RuntimeDependency, RuntimeDependencyDefinition, RuntimeDependencyVersion } from './runtime-dependency.js'

export function runtimeConflicts(version: RuntimeDependencyVersion, other: RuntimeDependency): string[] {
  return (other.current?.commands ?? [])
    .filter(command => version.commands.includes(command) && !(command === 'python3' && version.python && other.current?.python))
    .map(command => `${other.name}: ${command}`)
}
export function replaceRuntimeDefinition(row: RuntimeDependency, input: RuntimeDependencyDefinition): RuntimeDependency {
  const { packages, ...base } = { ...row, packages: row.type === 'python-library' ? row.packages : undefined }
  void packages
  const { name, prepareCommand, pathDirectories, checkCommand, type, ...metadata } = base
  void name
  void prepareCommand
  void pathDirectories
  void checkCommand
  void type
  return { ...metadata, ...input }
}
export function runtimeDefinition(row: RuntimeDependency): RuntimeDependencyDefinition {
  const common = {
    name: row.name,
    prepareCommand: row.prepareCommand,
    pathDirectories: row.pathDirectories,
    ...(row.checkCommand ? { checkCommand: row.checkCommand } : {}),
  }
  return row.type === 'python-library'
    ? { ...common, type: row.type, packages: row.packages }
    : row.type === 'resource'
      ? { ...common, type: row.type }
      : common
}
