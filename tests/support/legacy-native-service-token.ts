import { createHash, createHmac } from 'node:crypto'
import { expect } from 'vitest'
import type { CommunityAccountActor } from '../../src/domain/community-account.js'
import type { CommunityUserInstance } from '../../src/ports/community-runtime.js'
import type { PlatformSigningKeyPort } from '../../src/ports/platform-signing-key.js'
import type { PluginInstallationsPort, PluginServiceSettingsHistoryPort } from '../../src/ports/plugin-installations.js'
import type { createRealDshRpc } from './real-dsh-rpc.js'

/** Restore the 0.1.35 member profile and ownership fingerprint before entering the new runtime. */
export async function seedLegacyNativeServiceToken(input: {
  actor: CommunityAccountActor
  instance: CommunityUserInstance
  signingKey: PlatformSigningKeyPort
  previousGrant: { url: string }
  load: () => Promise<{ revision: number; data: { settings: { ai: Record<string, unknown> }; workspace: { activeFile: string } } }>
  rpc: ReturnType<typeof createRealDshRpc>
  origin: string
  cookie: string
  records: Pick<PluginInstallationsPort, 'get'> & PluginServiceSettingsHistoryPort
  packageName: string
}): Promise<void> {
  const { actor, instance, signingKey, previousGrant, load, rpc, origin, cookie, records, packageName } = input
  const scopeBinding = new URL(previousGrant.url).pathname.split('/').at(-1)!
  const oldToken = createHmac('sha256', signingKey.read())
    .update('native-plugin-service\0')
    .update(JSON.stringify([actor.username, actor.spaceId, actor.sessionEpoch, instance.resourceKey, packageName, 'image', 'seedream', scopeBinding]))
    .digest('base64url')
  const beforeRestart = await load()
  const oldAi = beforeRestart.data.settings.ai
  const oldImages = (oldAi.images as { id: string; snap: Record<string, unknown> }[]).map(row =>
    row.id === oldAi.imageId ? { ...row, snap: { ...row.snap, imageKey: oldToken } } : row,
  )
  const oldProfile = oldImages.find(row => row.id === oldAi.imageId)!
  await rpc.remoteRpc(origin, cookie, 'qiaomuCoverDesign/save', {
    request: {
      revision: beforeRestart.revision,
      data: { ...beforeRestart.data, settings: { ai: { ...oldAi, imageKey: oldToken, images: oldImages } } },
    },
  })
  const oldDelivery = (await records.get(actor.spaceId)).find(row => row.packageName === packageName)!
  const imageHistory = oldDelivery.serviceSettings?.image
  expect(imageHistory).toBeDefined()
  const ownedKeys = ['imageBaseUrl', 'imageEngine', 'imageKey', 'imageModel', 'imageOn']
  const oldFingerprint = createHash('sha256')
    .update(JSON.stringify(ownedKeys.map(name => [name, oldProfile.snap[name]])))
    .digest('hex')
  expect(
    await records.replaceServiceSettings(actor.spaceId, oldDelivery, {
      ...oldDelivery.serviceSettings,
      image: { contract: imageHistory!.contract, applied: oldFingerprint },
    }),
  ).toBe(true)
}
