import type { CommunityPluginView } from '../domain/admin-contract.js'
import { BusinessRuleError } from '../domain/business-error.js'
import type { CommunityAccountActor } from '../domain/community-account.js'
import {
  assertPluginIdentity,
  assertPluginSource,
  pluginIdentities,
  pluginLibraryView,
  PluginPreparationError,
  uploadPluginSource,
  type LibraryPlugin,
  type PluginCandidate,
  type PluginSource,
  type UploadedPlugin,
} from '../domain/plugin-library.js'
import type { PluginLibraryStorePort, PluginUploadPort } from '../ports/plugin-library.js'
import { KeyedOperations } from './support/keyed-operations.js'

/** Library facts an in-flight upload re-checks inside the package queue once its bytes are known. */
export interface PluginUploadOwner {
  assertAdmin(actor: CommunityAccountActor): Promise<void>
  assertIdle(packageName: string): void
  assertWritable(packageName: string): Promise<void>
  stopped(): boolean
  readonly operations: KeyedOperations
  readonly store: Pick<PluginLibraryStorePort, 'list'>
  enqueue(row: LibraryPlugin, administrator?: CommunityAccountActor): Promise<CommunityPluginView>
  enqueueReplacement(input: PluginCandidate, source: PluginSource): Promise<CommunityPluginView>
}

/** Accepts uploaded bytes under the library's package queue; the caller keeps the intake task registered. */
export async function receivePluginUpload(
  owner: PluginUploadOwner,
  uploads: PluginUploadPort,
  actor: CommunityAccountActor,
  filename: string,
  content: AsyncIterable<Uint8Array>,
  signal: AbortSignal,
  replacing?: string,
): Promise<CommunityPluginView> {
  let uploaded: UploadedPlugin | undefined
  let accepted = false
  try {
    uploaded = await uploads.accept(filename, content, signal)
    signal.throwIfAborted()
    const candidate = uploaded
    return await owner.operations.run(candidate.packageName, async () => {
      await owner.assertAdmin(actor)
      assertPluginIdentity(candidate)
      if (owner.stopped()) throw new PluginPreparationError('plugin-job-interrupted')
      // Re-checked after the upload await: a catalog task may have claimed the package meanwhile.
      await owner.assertWritable(candidate.packageName)
      const existing = (await owner.store.list()).find(row => row.packageName === candidate.packageName)
      assertPluginSource(existing, uploadPluginSource)
      if (replacing !== undefined) {
        if (replacing !== candidate.packageName || !existing) throw new PluginPreparationError('plugin-package-invalid')
        owner.assertIdle(replacing)
        if (pluginIdentities(existing)[candidate.version] !== undefined && pluginIdentities(existing)[candidate.version] !== candidate.integrity)
          throw new BusinessRuleError('conflict', 'This version already has different content.', 'plugin-version-conflict')
        const result = await owner.enqueueReplacement(
          {
            packageName: candidate.packageName,
            version: candidate.version,
            upload: { archive: candidate.archive, integrity: candidate.integrity },
          },
          uploadPluginSource,
        )
        accepted = true
        return result
      }
      if (existing) {
        if (existing.version !== candidate.version) throw new BusinessRuleError('conflict', 'This package is already in the library.', 'plugin-name-in-use')
        if ((existing.upload?.integrity ?? existing.current?.integrity) !== candidate.integrity)
          throw new BusinessRuleError('conflict', 'This package version already has different or unverified content.', 'plugin-version-conflict')
        return pluginLibraryView(existing)
      }
      const result = await owner.enqueue(
        {
          packageName: candidate.packageName,
          version: candidate.version,
          source: uploadPluginSource,
          upload: { archive: candidate.archive, integrity: candidate.integrity },
          stage: 'resolving',
          current: null,
          published: false,
        },
        actor,
      )
      accepted = true
      return result
    })
  } finally {
    if (uploaded && !accepted) await uploads.discard(uploaded.archive)
  }
}
