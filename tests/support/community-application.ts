import { mkdirSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { join, resolve } from 'node:path'
import { inject } from 'vitest'
import type { CommunityConfig } from '../../src/domain/community-config.js'
import { FilePlatformDatabaseConfig } from '../../src/adapters/platform-database-config.js'
import { createCommunityApplication as createApplication, type CommunityApplicationOptions } from '../../src/composition/community-application.js'
import { PlatformDatabase } from '../../src/adapters/platform-database.js'
import { PostgresCommunityAccountStore } from '../../src/adapters/postgres-community-accounts.js'
import { PostgresCommunityModelAccess } from '../../src/adapters/postgres-community-model-access.js'
import { PostgresSharedModelStore } from '../../src/adapters/postgres-shared-model-store.js'
import { createMcpStorage } from '../../src/composition/mcp-storage.js'
import { PostgresRuntimeDependencyStore } from '../../src/adapters/postgres-runtime-dependencies.js'
import { PostgresExecutionConfigurations } from '../../src/adapters/postgres-execution-configurations.js'
import { FileSharedModelProjection } from '../../src/adapters/shared-model-projection.js'
import { knownModelInput } from '../../src/domain/shared-models.js'
import { postgresConnection } from './postgres.js'
export type { CommunityApplicationOptions }
/** Fictional fixture inputs are seeded into real PG, never passed to production configuration. */
export type TestCommunityConfig = CommunityConfig & { sessionSecret?: string; modelGateway?: { upstreamApiKey: string } }
const configurations = new Map<string, string>()
/** Scoped real database fixture for execution seed/read operations, including installed builds. */
export async function withTestExecutionConfigurations<T>(
  dataRoot: string,
  run: (store: PostgresExecutionConfigurations) => Promise<T> | T,
  installedRoot?: string,
): Promise<T> {
  const Store = installedRoot
    ? (
        (await import(
          pathToFileURL(join(installedRoot, 'dist/adapters/postgres-execution-configurations.js')).href
        )) as typeof import('../../src/adapters/postgres-execution-configurations.js')
      ).PostgresExecutionConfigurations
    : PostgresExecutionConfigurations
  const database = await openTestDatabase(dataRoot, installedRoot),
    store = new Store(database)
  try {
    await store.initialize()
    return await run(store)
  } finally {
    try {
      await store.close()
    } finally {
      await database.close()
    }
  }
}
/** Scoped real database fixture for MCP seed/read operations, including installed builds. */
export async function withTestMcpStore<T>(
  dataRoot: string,
  run: (store: ReturnType<typeof createMcpStorage>) => Promise<T> | T,
  installedRoot?: string,
): Promise<T> {
  const create = installedRoot
    ? ((await import(pathToFileURL(join(installedRoot, 'dist/composition/mcp-storage.js')).href)) as typeof import('../../src/composition/mcp-storage.js'))
        .createMcpStorage
    : createMcpStorage
  const database = await openTestDatabase(dataRoot, installedRoot),
    store = create(database)
  try {
    await store.initialize()
    return await run(store)
  } finally {
    try {
      await store.close()
    } finally {
      await database.close()
    }
  }
}
/** Scoped ordinary runtime row queries against the selected source or installed build. */
export async function withTestRuntimeDependencies<T>(
  dataRoot: string,
  run: (store: PostgresRuntimeDependencyStore) => Promise<T> | T,
  installedRoot?: string,
): Promise<T> {
  const Store = installedRoot
    ? (
        (await import(
          pathToFileURL(join(installedRoot, 'dist/adapters/postgres-runtime-dependencies.js')).href
        )) as typeof import('../../src/adapters/postgres-runtime-dependencies.js')
      ).PostgresRuntimeDependencyStore
    : PostgresRuntimeDependencyStore
  const database = await openTestDatabase(dataRoot, installedRoot)
  try {
    return await run(new Store(database))
  } finally {
    await database.close()
  }
}
/** Real per-application database and local keys; no substitute storage or production fallback. */
export function withTestDatabase(config: CommunityConfig): CommunityConfig {
  return config.platformDatabaseConfigFile ? config : { ...config, platformDatabaseConfigFile: testDatabaseConfigFile(config.runtime.dataRoot) }
}
export function testDatabaseConfigFile(dataRoot: string): string {
  const identity = resolve(dataRoot)
  let path = configurations.get(identity)
  if (!path) {
    const root = join(inject('postgres').root, 'application-' + randomUUID())
    mkdirSync(root, { mode: 0o700 })
    path = join(root, 'database.json')
    FilePlatformDatabaseConfig.create(path, join(root, 'master.key'), postgresConnection())
    configurations.set(identity, path)
  }
  return path
}
export function createCommunityApplication(config: TestCommunityConfig, options: CommunityApplicationOptions = {}) {
  const { sessionSecret, modelGateway, ...production } = config
  const prepared = withTestDatabase(production)
  if (sessionSecret || modelGateway) {
    mkdirSync(config.runtime.dataRoot, { recursive: true, mode: 0o700 })
    const saved = FilePlatformDatabaseConfig.open(prepared.platformDatabaseConfigFile!, config.runtime.dataRoot)
    if (saved.selection === undefined)
      FilePlatformDatabaseConfig.select(prepared.platformDatabaseConfigFile!, config.runtime.dataRoot, saved.connection, 'builtin')
  }
  const application = createApplication(prepared, options)
  return {
    stop: () => application.stop(),
    start: async () => {
      if (sessionSecret || modelGateway) await seedTestSecrets(config)
      return await application.start()
    },
  }
}

export async function seedTestSecrets(config: TestCommunityConfig, installedRoot?: string): Promise<void> {
  const Store = installedRoot
    ? (
        (await import(
          pathToFileURL(join(installedRoot, 'dist/adapters/postgres-shared-model-store.js')).href
        )) as typeof import('../../src/adapters/postgres-shared-model-store.js')
      ).PostgresSharedModelStore
    : PostgresSharedModelStore
  const Projection = installedRoot
    ? (
        (await import(
          pathToFileURL(join(installedRoot, 'dist/adapters/shared-model-projection.js')).href
        )) as typeof import('../../src/adapters/shared-model-projection.js')
      ).FileSharedModelProjection
    : FileSharedModelProjection
  const database = await openTestDatabase(config.runtime.dataRoot, installedRoot)
  try {
    if (config.sessionSecret) {
      const encrypted = database.cipher().encrypt({ table: 'session_signing_key', recordId: '1', field: 'signing_key' }, config.sessionSecret)
      await database.query('INSERT INTO dsh_phalanx.session_signing_key(id,signing_key) VALUES(1,$1) ON CONFLICT(id) DO NOTHING', [JSON.stringify(encrypted)])
    }
    if (config.modelGateway) {
      const store = new Store(database, new Projection(config.runtime.dataRoot, config.runtime))
      try {
        await store.initialize()
        if (store.read().revision === 0)
          await store.save({
            revision: 1,
            defaultModelId: config.runtime.defaultModel.model,
            providers: [
              {
                id: 'fixture-deepseek',
                name: 'DeepSeek',
                apiFormat: 'anthropic-messages',
                baseUrl: config.runtime.defaultModel.upstream.baseUrl.replace(/\/+$/u, '') + '/anthropic',
                apiKey: config.modelGateway.upstreamApiKey,
                enabled: true,
                models: [
                  {
                    id: config.runtime.defaultModel.model,
                    name: config.runtime.defaultModel.model,
                    enabled: true,
                    input: knownModelInput(config.runtime.defaultModel.model),
                  },
                ],
              },
            ],
          })
      } finally {
        await store.close()
      }
    }
  } finally {
    await database.close()
  }
}

/** Open an independent connection owner for real database fixture setup. */
export async function openTestDatabase(dataRoot: string, installedRoot?: string) {
  const Saved = installedRoot
    ? (
        (await import(
          pathToFileURL(join(installedRoot, 'dist/adapters/platform-database-config.js')).href
        )) as typeof import('../../src/adapters/platform-database-config.js')
      ).FilePlatformDatabaseConfig
    : FilePlatformDatabaseConfig
  const Database = installedRoot
    ? (
        (await import(
          pathToFileURL(join(installedRoot, 'dist/adapters/platform-database.js')).href
        )) as typeof import('../../src/adapters/platform-database.js')
      ).PlatformDatabase
    : PlatformDatabase
  mkdirSync(dataRoot, { recursive: true, mode: 0o700 })
  const path = testDatabaseConfigFile(dataRoot)
  let config = Saved.open(path, dataRoot)
  // Explicit fixture seeding represents a chosen built-in database. Fresh onboarding
  // uses testDatabaseConfigFile directly and must retain its pending, empty state.
  if (config.selection === undefined) {
    Saved.select(path, dataRoot, config.connection, 'builtin')
    config = Saved.open(path, dataRoot)
  }
  const database = new Database(config.connection, config.security)
  try {
    await database.initialize()
    return database
  } catch (error) {
    await database.close()
    throw error
  }
}

/** Seed through the production account adapter in this application's real database. */
export async function openTestAccounts(dataRoot: string) {
  const database = await openTestDatabase(dataRoot)
  return Object.assign(new PostgresCommunityAccountStore(database), { close: () => database.close() })
}

/** An independent real PG token owner for gateway and installed runtime assertions. */
export async function openTestModelAccess(dataRoot: string, installedRoot = process.env.DSH_PHALANX_INSTALL_ROOT) {
  const Access = installedRoot
    ? (
        (await import(
          pathToFileURL(join(installedRoot, 'dist/adapters/postgres-community-model-access.js')).href
        )) as typeof import('../../src/adapters/postgres-community-model-access.js')
      ).PostgresCommunityModelAccess
    : PostgresCommunityModelAccess
  const database = await openTestDatabase(dataRoot, installedRoot),
    access = new Access(database)
  try {
    await access.initialize()
  } catch (error) {
    await database.close()
    throw error
  }
  return {
    forUser: access.forUser.bind(access),
    resolve: access.resolve.bind(access),
    version: access.version.bind(access),
    close: async () => {
      await access.close()
      await database.close()
    },
  }
}
export async function modelAccessToken(dataRoot: string, username: string, spaceId: string): Promise<string> {
  const access = await openTestModelAccess(dataRoot)
  try {
    return await access.forUser(username, spaceId)
  } finally {
    await access.close()
  }
}
