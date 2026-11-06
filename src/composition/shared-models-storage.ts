import { MemberModelsProjection } from '../adapters/member-models.js'
import { PostgresSharedModelStore } from '../adapters/postgres-shared-model-store.js'
import { FileSharedModelProjection } from '../adapters/shared-model-projection.js'
import type { PlatformDatabase } from '../adapters/platform-database.js'
import type { CommunityRuntimeConfig } from '../domain/community-config.js'

/** One shared model storage assembly: the committed store and its global and per-space projections. */
export function createSharedModelStorage(
  database: PlatformDatabase,
  dataRoot: string,
  runtime: CommunityRuntimeConfig,
): { readonly store: PostgresSharedModelStore; readonly memberModels: MemberModelsProjection } {
  const store = new PostgresSharedModelStore(database, new FileSharedModelProjection(dataRoot, runtime))
  const memberModels = new MemberModelsProjection(dataRoot, () => store.read(), runtime)
  store.attachMembers(memberModels)
  return { store, memberModels }
}
