import type { SuiteCatalogRuntimeDependencyItem } from './suite-catalog.js'

const architectures = ['amd64', 'arm64'] as const
const pathPattern = /^[A-Za-z0-9._@/-]{1,512}$/u
const sha256Pattern = /^[a-f0-9]{64}$/u
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

/** Check data files in the prepared resource, using the existing read-only check phase. */
export function resourceReadiness(
  item: SuiteCatalogRuntimeDependencyItem,
  value: unknown,
): Pick<SuiteCatalogRuntimeDependencyItem, 'resourceChecks' | 'resourceFiles'> | undefined {
  if (item.type !== 'resource' || item.checkCommand || !Array.isArray(value) || value.length === 0 || value.length > 32) return
  const available = architectures.filter(arch => item.prepareCommands[arch] !== undefined)
  if (!available.length) return
  const files = new Map<string, { readonly path: string; readonly executable?: true }>()
  const checks = available.map(arch => ({ arch, lines: ['set -eu'] }))
  for (const file of value) {
    if (!record(file) || Object.keys(file).some(key => !['path', 'sha256', 'executable'].includes(key))) return
    const { path, sha256, executable } = file
    if (
      typeof path !== 'string' ||
      pathPattern.exec(path)?.[0] !== path ||
      path.split('/').some(part => !part || part === '.' || part === '..') ||
      files.has(path) ||
      (executable !== undefined && executable !== true)
    )
      return
    if (!record(sha256) || Object.keys(sha256).length !== available.length) return
    files.set(path, { path, ...(executable ? { executable } : {}) })
    for (const { arch, lines } of checks) {
      const digest = sha256[arch]
      if (typeof digest !== 'string' || sha256Pattern.exec(digest)?.[0] !== digest) return
      lines.push(
        `test -f './${path}'`,
        `test "$(/usr/bin/realpath -e -- './${path}')" = "$(pwd -P)/${path}"`,
        ...(executable ? [`test -x './${path}'`] : []),
        `printf '%s  %s\n' '${digest}' './${path}' | /usr/bin/sha256sum -c -`,
      )
    }
  }
  return {
    resourceChecks: Object.fromEntries(checks.map(({ arch, lines }) => [arch, lines.join('\n')])),
    resourceFiles: [...files.values()],
  }
}
