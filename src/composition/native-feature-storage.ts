import { PostgresPluginInstallations } from '../adapters/postgres-plugin-installations.js'
import { PostgresNativeFeatures } from '../adapters/postgres-native-features.js'
import { PostgresSpaceActors } from '../adapters/postgres-space-actors.js'
import { PostgresUnitOfWork } from '../adapters/postgres-unit-of-work.js'
import type { PlatformDatabase } from '../adapters/platform-database.js'
import type { NativeFeaturePersistence } from '../ports/native-features.js'

export function createNativeFeatureStorage(database: PlatformDatabase): NativeFeaturePersistence {
  return {
    rows: new PostgresNativeFeatures(database),
    work: new PostgresUnitOfWork(database, {
      actors: transaction => new PostgresSpaceActors(transaction),
      features: transaction => new PostgresNativeFeatures(transaction),
    }),
  }
}

export function createNativePluginHistoryStorage(database: PlatformDatabase): import('../ports/native-plugin-history.js').NativePluginHistoryPersistence {
  return {
    work: new PostgresUnitOfWork(database, {
      actors: transaction => new PostgresSpaceActors(transaction),
      history: transaction => new PostgresNativePluginHistory(transaction),
      deliveries: transaction => new PostgresPluginInstallations(transaction),
    }),
  }
}
import { PostgresNativePluginHistory } from '../adapters/postgres-native-plugin-history.js'
