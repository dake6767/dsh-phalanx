import { createHash } from 'node:crypto'
import { catalogPluginPredecessor, pluginIdentities, type LibraryPlugin, type PreparedPlugin } from './plugin-library.js'
import type { CommunityPluginUpdateChoice } from './plugin-admin-contract.js'
import { compareStrictVersions } from './semver.js'

type UpdateInventory = {
  readonly retainedArchive?: true
  readonly version?: string
  readonly archiveIntegrity?: string
  readonly enabled?: boolean
  readonly incompatibleArchive?: { readonly integrity: string; readonly enabled: boolean }
}

export function nativeUpdatePrevious(installed: UpdateInventory) {
  if (!installed.retainedArchive || !installed.version) return undefined
  const { version, incompatibleArchive, archiveIntegrity, enabled } = installed
  if (incompatibleArchive) return { version, ...incompatibleArchive, incompatibleRuntime: true as const }
  if (archiveIntegrity && enabled !== undefined) return { version, integrity: archiveIntegrity, enabled }
  return undefined
}

/** Match current DSH identity to a member delivery and a checked library archive. */
export function nativeUpdateChoice(
  installed: UpdateInventory,
  target: PreparedPlugin,
  library: LibraryPlugin,
  delivery?: { readonly version: string; readonly integrity?: string },
): CommunityPluginUpdateChoice | undefined {
  const previous = nativeUpdatePrevious(installed)
  if (!previous) return undefined
  const { version, integrity: archiveIntegrity } = previous
  const identities = pluginIdentities(library)
  const legacy = library.identities?.['legacy:' + version] ?? identities[version]
  if (
    delivery?.version !== version ||
    (delivery.integrity ?? legacy) !== archiveIntegrity ||
    !/^sha512-[A-Za-z0-9+/]{86}==$/u.test(target.integrity) ||
    (identities[version] !== archiveIntegrity && legacy !== archiveIntegrity && library.identities?.[version + ':' + archiveIntegrity] !== archiveIntegrity) ||
    archiveIntegrity === target.integrity
  )
    return undefined
  const comparison = compareStrictVersions(target.version, version)
  if (comparison === undefined) return undefined
  if (comparison < 0) {
    const predecessor = catalogPluginPredecessor(library, target)
    if (predecessor?.version !== version || predecessor.integrity !== archiveIntegrity || delivery.integrity !== archiveIntegrity) return undefined
  }
  return {
    kind: comparison !== 0 ? 'version' : 'content',
    version: target.version,
    target: createHash('sha256')
      .update(
        JSON.stringify([
          version,
          archiveIntegrity,
          target.version,
          target.integrity,
          target.artifact,
          target.preparationId,
          target.sourceCommit,
          ...('incompatibleRuntime' in previous ? [previous.incompatibleRuntime] : []),
        ]),
      )
      .digest('hex'),
  }
}
