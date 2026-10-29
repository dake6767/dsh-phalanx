import { createHash } from 'node:crypto'
import { closeSync, constants, fstatSync, openSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { basename, dirname, isAbsolute, join } from 'node:path'
import type { DatabaseSwitchJournal } from '../domain/platform-database-operation.js'
import { FilePlatformDatabaseConfig } from './platform-database-config.js'
import { FilePlatformSecrets } from './platform-secrets.js'
import { platformFileExists, readPlatformPrivateFile, syncPlatformDirectory, writePlatformPrivateFile } from './platform-private-file.js'

export const databaseSwitchJournalPath = (configFile: string) => join(dirname(configFile), 'platform-database-operation.json')
export const platformConfigurationHash = (value: string) => createHash('sha256').update(value).digest('hex')
export function readDatabaseSwitchJournal(configFile: string, dataRoot: string): DatabaseSwitchJournal | undefined {
  configFile = join(realpathSync(dirname(configFile)), basename(configFile))
  dataRoot = realpathSync(dataRoot)
  const path = databaseSwitchJournalPath(configFile)
  if (!platformFileExists(path)) return undefined
  let journal: DatabaseSwitchJournal
  const invalid = () => Error('Invalid protected database switch operation; restore its matching configuration')
  try {
    journal = JSON.parse(readPlatformPrivateFile(path)) as typeof journal
  } catch {
    throw invalid()
  }
  if (
    !journal ||
    journal.version !== 1 ||
    journal.kind !== 'database-switch' ||
    !/^[a-f0-9-]{36}$/u.test(journal.id) ||
    !['preparing', 'copying', 'committing', 'committed', 'rolled-back'].includes(journal.phase) ||
    journal.configFile !== configFile ||
    journal.dataRoot !== dataRoot ||
    typeof journal.original !== 'string' ||
    journal.original.length > 65536 ||
    journal.originalHash !== platformConfigurationHash(journal.original) ||
    (journal.nextHash !== undefined && !/^[a-f0-9]{64}$/u.test(journal.nextHash)) ||
    typeof journal.deploymentId !== 'string' ||
    typeof journal.maintenanceFile !== 'string' ||
    !isAbsolute(journal.maintenanceFile) ||
    typeof journal.marker !== 'string' ||
    journal.marker.length > 4096 ||
    journal.archive !== join(dirname(configFile), 'database-transfer-' + journal.id + '.jsonl') ||
    journal.staging !== configFile + '.tmp-database-' + journal.id ||
    (journal.managedOperation !== undefined && !/^[a-f0-9-]{36}$/u.test(journal.managedOperation))
  )
    throw invalid()
  const current = FilePlatformDatabaseConfig.readProtected(configFile, dataRoot)
  let original: typeof current
  try {
    original = JSON.parse(journal.original) as typeof current
  } catch {
    throw invalid()
  }
  if (
    original.deploymentId !== journal.deploymentId ||
    current.deploymentId !== journal.deploymentId ||
    original.masterKeyPath !== current.masterKeyPath ||
    original.registry?.masterFingerprint !== current.registry.masterFingerprint
  )
    throw invalid()
  FilePlatformSecrets.open(original.masterKeyPath, original.registry).close()
  if (journal.managedOperation) {
    const marker = JSON.parse(journal.marker) as { schema?: number; operation?: string; operationKind?: string; deploymentId?: string }
    if (
      marker.schema !== 1 ||
      marker.operation !== journal.managedOperation ||
      marker.operationKind !== 'database-switch' ||
      marker.deploymentId !== journal.deploymentId
    )
      throw invalid()
  }
  return journal
}

/** Caller owns the local lock. A failed switch always restores the exact original selection. */
export function rollbackDatabaseSwitch(journal: DatabaseSwitchJournal): DatabaseSwitchJournal {
  assertDatabaseSwitchMarker(journal)
  const current = readPlatformPrivateFile(journal.configFile),
    hash = platformConfigurationHash(current)
  if (hash !== journal.originalHash && hash !== journal.nextHash) throw Error('Database configuration changed outside the pending switch')
  if (hash !== journal.originalHash) writePlatformPrivateFile(journal.configFile, journal.original, current)
  const restored = { ...journal, phase: 'rolled-back' as const },
    path = databaseSwitchJournalPath(journal.configFile)
  writePlatformPrivateFile(path, JSON.stringify(restored) + '\n', readPlatformPrivateFile(path))
  return restored
}
export function clearDatabaseSwitch(journal: DatabaseSwitchJournal): void {
  assertDatabaseSwitchMarker(journal)
  if (!journal.managedOperation && platformFileExists(journal.maintenanceFile)) {
    rmSync(journal.maintenanceFile)
    syncPlatformDirectory(dirname(journal.maintenanceFile))
  }
  for (const path of [journal.archive, journal.staging]) rmSync(path, { force: true })
  syncPlatformDirectory(dirname(journal.configFile))
  rmSync(databaseSwitchJournalPath(journal.configFile))
  syncPlatformDirectory(dirname(journal.configFile))
}
/** Managed startup waits for root; unmanaged interruption rolls back before opening production. */
export function prepareDatabaseSwitchRecovery(configFile: string, dataRoot: string): void {
  const journal = readDatabaseSwitchJournal(configFile, dataRoot)
  if (!journal) return
  if (journal.managedOperation) {
    if (!['committed', 'rolled-back'].includes(journal.phase)) throw Error('A managed database switch must be recovered by the independent operation service')
    return
  }
  clearDatabaseSwitch(rollbackDatabaseSwitch(journal))
}

function assertDatabaseSwitchMarker(journal: DatabaseSwitchJournal): void {
  if (!platformFileExists(journal.maintenanceFile)) {
    if (journal.managedOperation) throw Error('The managed database marker disappeared')
    return // Preparing or interrupted final cleanup can precede/follow our own marker.
  }
  const file = openSync(journal.maintenanceFile, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const info = fstatSync(file)
    if (
      !info.isFile() ||
      (!journal.managedOperation && info.uid !== process.getuid?.()) ||
      (info.mode & 0o022) !== 0 ||
      info.size > 4096 ||
      readFileSync(file, 'utf8') !== journal.marker
    )
      throw Error('Database maintenance marker ownership changed')
  } finally {
    closeSync(file)
  }
}
