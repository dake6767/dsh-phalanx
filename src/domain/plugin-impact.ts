import type { CommunityPluginImpact } from './admin-contract.js'
import type { LibraryPlugin } from './plugin-library.js'
import type { ExpertReferenceImpact } from './expert-reference.js'
import { libraryProvenanceRevision } from './library-contribution.js'

/** A replacement confirms the same library, membership and expert impact as removal. */
export function pluginImpact(
  row: LibraryPlugin,
  members: Omit<CommunityPluginImpact, 'revision' | 'experts'>,
  references?: ExpertReferenceImpact,
): CommunityPluginImpact {
  return {
    ...members,
    experts: references?.experts ?? [],
    revision: JSON.stringify([
      row.revision,
      row.version,
      row.current?.integrity,
      row.replacement?.prepared?.integrity,
      row.removing,
      libraryProvenanceRevision(row.provenance),
      members,
      references?.revision,
    ]),
  }
}
