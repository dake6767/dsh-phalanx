import { createHash } from 'node:crypto'
import { pluginIdentities, type LibraryPlugin, type PreparedPlugin } from './plugin-library.js'
import type { CommunityPluginUpdateChoice } from './plugin-admin-contract.js'
import { compareStrictVersions } from './semver.js'

/** Match current DSH identity to a member delivery and a checked library archive. */
export function nativeUpdateChoice(
  installed: { readonly retainedArchive?: true; readonly version?: string; readonly archiveIntegrity?: string; readonly enabled?: boolean },
  target: PreparedPlugin,
  library: LibraryPlugin,
  delivery?: { readonly version: string; readonly integrity?: string },
): CommunityPluginUpdateChoice | undefined {
  const { version, archiveIntegrity, enabled } = installed
  if (!version || !archiveIntegrity) return undefined
  const identities = pluginIdentities(library)
  const legacy = library.identities?.['legacy:' + version] ?? identities[version]
  if (
    !installed.retainedArchive ||
    enabled === undefined ||
    delivery?.version !== version ||
    (delivery.integrity ?? legacy) !== archiveIntegrity ||
    !/^sha512-[A-Za-z0-9+/]{86}==$/u.test(target.integrity) ||
    (identities[version] !== archiveIntegrity && legacy !== archiveIntegrity && library.identities?.[version + ':' + archiveIntegrity] !== archiveIntegrity) ||
    archiveIntegrity === target.integrity
  )
    return undefined
  const comparison = compareStrictVersions(target.version, version)
  if (comparison === undefined || comparison < 0) return undefined
  return {
    kind: comparison > 0 ? 'version' : 'content',
    version: target.version,
    target: createHash('sha256')
      .update(JSON.stringify([version, archiveIntegrity, target.version, target.integrity, target.artifact, target.preparationId, target.sourceCommit]))
      .digest('hex'),
  }
}
