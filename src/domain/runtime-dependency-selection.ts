import { BusinessRuleError } from './business-error.js'
import { assertPublicRuntimeDependency, type RuntimeDependency, type RuntimeDependencyVersion } from './runtime-dependency.js'

/** Resolve usable facts from one request or transaction's dependency rows. */
export function readyRuntimeDependencies(
  rows: readonly RuntimeDependency[],
  names: readonly string[],
  includeCandidates = false,
): readonly RuntimeDependencyVersion[] {
  return [...new Set(names)].map(name => {
    const row = rows.find(item => item.name === name)
    if (!row) throw new BusinessRuleError('missing', 'Runtime dependency is unavailable.', 'runtime-dependency-unavailable')
    if (!includeCandidates) assertPublicRuntimeDependency(row)
    if (!row.current) throw new BusinessRuleError('conflict', 'Runtime dependency has no usable version.', 'runtime-dependency-unavailable', { name })
    return row.current.python ? { ...row.current, python: { ...row.current.python, name: row.name } } : row.current
  })
}
