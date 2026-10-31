import type { CommunityRuntimeConfig } from '../domain/community-config.js'
import { PostgresUserStorageFacts } from '../adapters/postgres-user-storage-facts.js'
import { UserStorageGuard } from '../adapters/user-storage-guard.js'
import { UNLIMITED_INSTANCE_RESOURCES } from '../domain/instance-resources.js'
import type { PlatformDatabase } from '../adapters/platform-database.js'
import { PostgresContainerHostnames } from '../adapters/postgres-container-hostnames.js'
import { PostgresEnvironmentResetHistory } from '../adapters/postgres-environment-reset-history.js'
import { PostgresInstanceResources } from '../adapters/postgres-instance-resources.js'
import { PostgresSpaceActors } from '../adapters/postgres-space-actors.js'
import { PostgresUnitOfWork } from '../adapters/postgres-unit-of-work.js'

/** Space facts share the database owner and bind their writes to explicit units of work. */
export function createSpaceStorage(
  database: PlatformDatabase,
  config: Pick<CommunityRuntimeConfig, 'dataRoot' | 'userDataRoot' | 'userDataMount' | 'container'>,
  idleSeconds = 1800,
  admitted: () => boolean = () => true,
) {
  const guard = new UserStorageGuard(
    config.dataRoot,
    new PostgresUserStorageFacts(database),
    config.userDataRoot,
    config.container !== undefined,
    config.userDataMount,
  )
  const resources = {
    rows: new PostgresInstanceResources(database),
    work: new PostgresUnitOfWork(database, {
      actors: tx => new PostgresSpaceActors(tx),
      settings: tx => new PostgresInstanceResources(tx),
    }),
  }
  return {
    hostnames: new PostgresContainerHostnames(database),
    guard,
    initialize: async () => {
      await resources.rows.initialize(UNLIMITED_INSTANCE_RESOURCES, idleSeconds)
      await guard.initialize({ readOnly: !admitted() })
    },
    resources,
    resets: {
      history: new PostgresEnvironmentResetHistory(database),
      work: new PostgresUnitOfWork(database, {
        actors: tx => new PostgresSpaceActors(tx),
        history: tx => new PostgresEnvironmentResetHistory(tx),
      }),
    },
  }
}
