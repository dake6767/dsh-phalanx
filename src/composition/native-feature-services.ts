import { NativeInstallAuthority } from '../adapters/native-install-authority.js'
import { SignedNativeInstallTransport } from '../adapters/native-install-transport.js'
import { NativePluginHistoryRuntimeAdapter } from '../adapters/native-plugin-history-runtime.js'
import type { PlatformDatabase } from '../adapters/platform-database.js'
import type { CommunityRuntimeConfig } from '../domain/community-config.js'
import { dshNativeFeatures, type DshNativeFeatureRegistration } from '../dsh/native-features.js'
import type { CommunityRuntimePort } from '../ports/community-runtime.js'
import { NativeFeatures } from '../use-cases/native-features.js'
import { NativePluginHistory } from '../use-cases/native-plugin-history.js'
import { createNativeFeatureStorage, createNativePluginHistoryStorage } from './native-feature-storage.js'

export function createNativeFeatureServices(
  database: PlatformDatabase,
  config: CommunityRuntimeConfig,
  additions: readonly DshNativeFeatureRegistration[] | undefined,
  runtime: () => CommunityRuntimePort,
  origin: () => URL,
) {
  const registry = dshNativeFeatures(additions)
  const policy = new NativeFeatures(registry.catalog, createNativeFeatureStorage(database))
  const history = new NativePluginHistory(createNativePluginHistoryStorage(database), new NativePluginHistoryRuntimeAdapter(runtime, origin))
  const authority = config.container ? new NativeInstallAuthority() : undefined
  return { policy, registry, history, ...(authority ? { publicKey: authority.publicKey, installation: new SignedNativeInstallTransport(authority) } : {}) }
}
