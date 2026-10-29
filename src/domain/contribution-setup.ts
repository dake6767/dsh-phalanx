import type { ContributionSetup } from './member-contribution.js'

/** Explicit protected fields plus their structural positions in an adoption's immutable setup. */
export function mapContributionSetup(
  setup: ContributionSetup,
  visit: (path: readonly (string | number)[], value: string, sensitive: boolean) => string,
): ContributionSetup {
  const walk = (value: unknown, path: readonly (string | number)[]): unknown => {
    // The whole request is opaque: arbitrary JSON object keys must not become
    // plaintext metadata or envelope field identities either.
    if (path[0] === 'plugin' && path[1] === 'upstreams' && path[3] === 'testRequest' && value != null) {
      const encoded = visit(path, typeof value === 'string' ? value : JSON.stringify(value), true)
      return encoded ? JSON.parse(encoded) : ''
    }
    if (typeof value === 'string') {
      const sensitive =
        (path[0] === 'plugin' &&
          ((path[1] === 'access' && (path[2] === 'entriesYaml' || (path[2] === 'environment' && path[4] === 'value'))) ||
            (path[1] === 'upstreams' && (path[3] === 'credential' || (path[3] === 'headers' && path[5] === 'value'))))) ||
        (path[0] === 'execution' && path[1] === 'variables' && path[3] === 'value' && setup.execution?.variables[Number(path[2])]?.secret === true)
      return visit(path, value, sensitive)
    }
    if (Array.isArray(value)) return value.map((row, index) => walk(row, [...path, index]))
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([name, row]) => [name, walk(row, [...path, name])]))
    return value
  }
  return walk(setup, []) as ContributionSetup
}
