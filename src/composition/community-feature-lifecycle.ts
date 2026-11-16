import { join } from 'node:path'
import { FilePlatformVoiceAssets } from '../adapters/platform-voice-assets.js'
import { PlatformDatabase } from '../adapters/platform-database.js'
import { FilePlatformDatabaseConfig } from '../adapters/platform-database-config.js'
import { prepareDatabaseSwitchRecovery } from '../adapters/platform-database-switch-recovery.js'
import { preparePlatformKeyRecovery } from '../adapters/platform-key-recovery.js'
import { PostgresPlatformVoice } from '../adapters/postgres-platform-voice.js'
import type { CommunityAccountReaderPort } from '../ports/community-accounts.js'
import type { DownloadSourceStorePort } from '../ports/download-sources.js'
import { voiceModelSource } from '../domain/download-source.js'
import { PlatformVoice } from '../use-cases/platform-voice.js'

export function createCommunityVoice(database: PlatformDatabase, accounts: CommunityAccountReaderPort, downloads: DownloadSourceStorePort, dataRoot: string) {
  const store = new PostgresPlatformVoice(database)
  const feature = new PlatformVoice(
    accounts,
    store,
    new FilePlatformVoiceAssets(join(dataRoot, 'platform-voice'), () => voiceModelSource[downloads.get().preset]),
  )
  return { feature, launch: { prepared: () => feature.prepared(), preferences: store } }
}

export async function initializeCommunityStores(...stores: readonly { initialize(): Promise<unknown> }[]): Promise<void> {
  for (const store of stores) await store.initialize()
}

export async function recoverCommunityStores(...stores: readonly ({ recover(): Promise<unknown> } | { prepare(): Promise<unknown> })[]): Promise<void> {
  for (const store of stores) {
    if ('recover' in store) await store.recover()
    else await store.prepare()
  }
}

export async function closeCommunityStores(...groups: ReadonlyArray<ReadonlyArray<{ close(): Promise<unknown> }>>): Promise<void> {
  await Promise.allSettled(groups.flat().map(store => store.close()))
}

export async function startCommunityFeatures(...features: readonly { start(): Promise<unknown> }[]): Promise<void> {
  for (const feature of features) await feature.start()
}

export function openCommunityDatabase(configFile: string | undefined, dataRoot: string): PlatformDatabase {
  const path = configFile ?? '/etc/dsh-phalanx/database.json'
  prepareDatabaseSwitchRecovery(path, dataRoot)
  preparePlatformKeyRecovery(path, dataRoot)
  const saved = FilePlatformDatabaseConfig.open(path, dataRoot)
  return new PlatformDatabase(saved.connection, saved.security)
}
