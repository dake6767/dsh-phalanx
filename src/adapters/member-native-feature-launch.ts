import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { CommunityRuntimeConfig } from '../domain/community-config.js'
import { communityOverlayUrl } from '../dsh/community-profile.js'
import { managedModelsDirectory } from '../dsh/shared-models.js'
import { nativePluginAccess, type NativeFeaturePatch } from '../dsh/native-features.js'
import { disableNativeCreatorTools } from '../dsh/native-creator-tools.js'
import type { buildCommunityContainerLaunchCommand } from '../dsh/container.js'
import { dumpNativeConfiguration } from './native-config-dump.js'
import { prepareMemberNativeFeatures } from './member-native-features.js'

/** Publish the final immutable member generation after every preceding invocation layer is ready. */
export async function prepareMemberNativeFeatureLaunch(
  input: {
    readonly config: CommunityRuntimeConfig
    readonly userId: string
    readonly spaceId: string
    readonly resourceKey: string
    readonly workspace: string
    readonly environment: Readonly<Record<string, string>>
    readonly platformPatch: string
    readonly modelsOverlay?: string
    readonly overlays: readonly ({ readonly patch: string } | undefined)[]
    readonly container?: Parameters<typeof buildCommunityContainerLaunchCommand>[0]
  },
  patch: readonly NativeFeaturePatch[],
  options: { readonly history: boolean; readonly publicKey?: string; readonly canDiscardArtifacts: () => boolean },
  signal: AbortSignal,
) {
  const patches = [
    ...(input.config.patches ?? []),
    fileURLToPath(communityOverlayUrl),
    input.modelsOverlay ?? join(input.config.dataRoot, managedModelsDirectory, 'overlay.yml'),
    input.platformPatch,
    ...input.overlays.flatMap(row => (row ? [row.patch] : [])),
  ]
  const access = nativePluginAccess(patch)
  const creatorPatch = access.restrictCreator
    ? disableNativeCreatorTools(
        await dumpNativeConfiguration(
          {
            config: input.config,
            workspace: input.workspace,
            environment: input.environment,
            patches,
            ...(input.container ? { container: input.container } : {}),
          },
          signal,
        ),
      )
    : undefined
  const features = await prepareMemberNativeFeatures(input.config.dataRoot, !!input.config.container, input.spaceId, patch, options.canDiscardArtifacts, {
    policy: {
      subject: input.userId,
      generation: input.resourceKey,
      allowInstall: access.allowInstall,
      history: options.history,
      ...(input.config.container && options.publicKey ? { publicKey: options.publicKey } : {}),
    },
    ...(creatorPatch ? { creatorPatch } : {}),
  })
  return { patches, features }
}
