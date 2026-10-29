import type { DatabaseSwitchJournal } from '../domain/platform-database-operation.js'
import { randomUUID } from 'node:crypto'
import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readFileSync, realpathSync, renameSync, statSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path'
import { requestedPlatformDatabaseConnection, type PlatformDatabaseConnection } from '../domain/platform-database.js'
import type { PlatformSecretRegistry } from '../domain/platform-secret.js'
import { FilePlatformDatabaseConfig } from './platform-database-config.js'
import { inspectPlatformDatabase } from './platform-database-inspection.js'
import { PlatformDatabaseMaintenance } from './platform-database-maintenance.js'
import { PlatformLock } from './platform-lock.js'
import { readPlatformPrivateFile, syncPlatformDirectory, writePlatformPrivateFile } from './platform-private-file.js'
import {
  clearDatabaseSwitch,
  databaseSwitchJournalPath,
  platformConfigurationHash,
  readDatabaseSwitchJournal,
  rollbackDatabaseSwitch,
} from './platform-database-switch-recovery.js'
import { transferPlatformSchema } from './platform-schema-transfer.js'

export type DatabaseSelection = 'builtin' | 'external'
function connectionInput(path: string, dataRoot: string): PlatformDatabaseConnection {
  const inside = relative(realpathSync(dataRoot), realpathSync(path))
  if (inside === '' || (inside !== '..' && !inside.startsWith('..' + sep) && !isAbsolute(inside)))
    throw Error('Database connection input must remain outside the data root')
  const file = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const stat = fstatSync(file)
    if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o600 || stat.size > 65536)
      throw Error('Database connection input requires a private regular 0600 file')
    let input: Record<string, unknown>
    try {
      input = JSON.parse(readFileSync(file, 'utf8')) as typeof input
    } catch {
      throw Error('Database connection input must be valid protected JSON')
    }
    if (
      !input ||
      typeof input !== 'object' ||
      Array.isArray(input) ||
      Object.keys(input).some(key => !['host', 'port', 'database', 'username', 'password', 'tls', 'ca'].includes(key)) ||
      !['host', 'database', 'username', 'password', 'tls'].every(key => typeof input[key] === 'string') ||
      typeof input.port !== 'number' ||
      (input.ca !== undefined && typeof input.ca !== 'string')
    )
      throw Error('Invalid database connection input fields')
    return requestedPlatformDatabaseConnection({
      host: input.host as string,
      port: String(input.port),
      database: input.database as string,
      username: input.username as string,
      password: input.password as string,
      tls: input.tls as string,
      ca: (input.ca as string) ?? '',
    })
  } finally {
    closeSync(file)
  }
}
function selection(configFile: string, dataRoot: string, target: DatabaseSelection, connectionFile?: string) {
  const source = FilePlatformDatabaseConfig.open(configFile, dataRoot)
  const builtin = FilePlatformDatabaseConfig.open(join(dirname(configFile), 'builtin-database.json'), dataRoot)
  if (
    !source.selection ||
    !source.deploymentId ||
    builtin.deploymentId !== source.deploymentId ||
    builtin.security.masterKeyPath !== source.security.masterKeyPath
  )
    throw Error('Database switching requires a selected deployment and matching built-in configuration')
  if (source.selection === target) throw Error('The requested platform database is already selected')
  const connection = target === 'builtin' ? builtin.connection : connectionFile ? connectionInput(connectionFile, dataRoot) : undefined
  if (!connection) throw Error('An external database requires a protected connection file')
  return { source, connection }
}

/** Read-only target admission runs before the root owner closes maintenance. */
export async function checkDatabaseSwitch(configFile: string, dataRoot: string, target: DatabaseSelection, connectionFile?: string) {
  const selected = selection(configFile, dataRoot, target, connectionFile)
  const checked = await inspectPlatformDatabase(selected.connection, selected.source.security.registry.masterFingerprint, selected.source.deploymentId)
  if (!checked.ok) throw Error('The target database failed connection, version, owner, schema or deployment checks')
  return {
    checked: true as const,
    selection: target,
    deploymentId: selected.source.deploymentId,
    fingerprint: selected.source.security.registry.masterFingerprint,
  }
}

/** The public offline CLI performs no source DML; the target import is one verified transaction. */
export async function switchPlatformDatabase(
  configFile: string,
  dataRoot: string,
  maintenanceFile: string,
  target: DatabaseSelection,
  connectionFile?: string,
  managedOperation?: string,
) {
  configFile = join(realpathSync(dirname(configFile)), basename(configFile))
  dataRoot = realpathSync(dataRoot)
  maintenanceFile = join(realpathSync(dirname(maintenanceFile)), basename(maintenanceFile))
  if (statSync(configFile).uid !== process.getuid?.()) throw Error('Run database maintenance as the configuration owner')
  const lock = new PlatformLock(dataRoot)
  try {
    const pending = readDatabaseSwitchJournal(configFile, dataRoot)
    if (pending) {
      if (pending.managedOperation !== managedOperation) throw Error('Recover the original database operation first')
      const restored = rollbackDatabaseSwitch(pending)
      if (!managedOperation) clearDatabaseSwitch(restored)
      return {
        status: 'rolled-back' as const,
        selection: FilePlatformDatabaseConfig.open(configFile, dataRoot).selection!,
        deploymentId: restored.deploymentId,
        operation: managedOperation,
        fingerprint: FilePlatformDatabaseConfig.open(configFile, dataRoot).security.registry.masterFingerprint,
      }
    }
    await checkDatabaseSwitch(configFile, dataRoot, target, connectionFile)
    return await performSwitch(configFile, dataRoot, maintenanceFile, target, connectionFile, managedOperation)
  } finally {
    lock.close()
  }
}
async function performSwitch(
  configFile: string,
  dataRoot: string,
  maintenanceFile: string,
  target: DatabaseSelection,
  connectionFile?: string,
  managedOperation?: string,
) {
  const sessions: PlatformDatabaseMaintenance[] = [],
    failures: unknown[] = []
  let journal: DatabaseSwitchJournal | undefined,
    completed = false
  try {
    if (!managedOperation)
      try {
        lstatSync(maintenanceFile)
        throw Error('Recover the existing maintenance operation first')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    const selected = selection(configFile, dataRoot, target, connectionFile)
    const source = await PlatformDatabaseMaintenance.open(
      selected.source.connection,
      selected.source.security.registry.masterFingerprint,
      selected.source.deploymentId!,
    )
    sessions.push(source)
    if (source.schema !== 'platform' || (await source.isSameDatabase(selected.connection)))
      throw Error('Database switching requires a different target database')
    const destination = await PlatformDatabaseMaintenance.open(
      selected.connection,
      selected.source.security.registry.masterFingerprint,
      selected.source.deploymentId!,
    )
    sessions.push(destination)
    const registry = (await source.query<{ registry: PlatformSecretRegistry }>('SELECT registry FROM dsh_phalanx.platform_security WHERE id=1'))[0]!.registry
    const id = randomUUID(),
      original = readPlatformPrivateFile(configFile),
      marker = managedOperation ? readFileSync(maintenanceFile, 'utf8') : JSON.stringify({ kind: 'platform-database-switch', id }) + '\n'
    if (managedOperation) {
      const value = JSON.parse(marker) as { schema?: number; operation?: string; operationKind?: string; deploymentId?: string }
      if (
        value.schema !== 1 ||
        value.operation !== managedOperation ||
        value.operationKind !== 'database-switch' ||
        value.deploymentId !== selected.source.deploymentId
      )
        throw Error('Managed database admission does not match this operation')
    }
    journal = {
      version: 1,
      kind: 'database-switch',
      phase: 'preparing',
      id,
      configFile,
      dataRoot,
      maintenanceFile,
      marker,
      deploymentId: selected.source.deploymentId!,
      ...(managedOperation ? { managedOperation } : {}),
      original,
      originalHash: platformConfigurationHash(original),
      archive: join(dirname(configFile), 'database-transfer-' + id + '.jsonl'),
      staging: configFile + '.tmp-database-' + id,
    }
    writePlatformPrivateFile(databaseSwitchJournalPath(configFile), JSON.stringify(journal) + '\n')
    if (!managedOperation) writePlatformPrivateFile(maintenanceFile, marker)
    FilePlatformDatabaseConfig.stageSelection(configFile, dataRoot, selected.connection, target, registry, journal.staging)
    journal = saveSwitchPhase(journal, 'copying', platformConfigurationHash(readPlatformPrivateFile(journal.staging)))
    await transferPlatformSchema(source, destination, journal.archive)
    journal = saveSwitchPhase(journal, 'committing')
    renameSync(journal.staging, configFile)
    syncPlatformDirectory(dirname(configFile))
    journal = saveSwitchPhase(journal, 'committed')
    completed = true
  } catch (error) {
    failures.push(error)
  }
  const closed = await Promise.allSettled(sessions.map(session => session.close()))
  failures.push(...closed.flatMap(result => (result.status === 'rejected' ? [result.reason] : [])))
  try {
    if (journal && existsSync(databaseSwitchJournalPath(configFile))) {
      if (failures.length || !completed) journal = rollbackDatabaseSwitch(journal)
      if (!managedOperation) clearDatabaseSwitch(journal)
    }
  } catch (error) {
    failures.push(error)
  }
  if (failures.length === 1) throw failures[0]
  if (failures.length) throw new AggregateError(failures, 'Database switching failed; inspect the protected operation')
  return {
    status: 'switched' as const,
    selection: target,
    operation: managedOperation,
    deploymentId: journal!.deploymentId,
    fingerprint: FilePlatformDatabaseConfig.open(configFile, dataRoot).security.registry.masterFingerprint,
  }
}
function saveSwitchPhase(journal: DatabaseSwitchJournal, phase: DatabaseSwitchJournal['phase'], nextHash = journal.nextHash): DatabaseSwitchJournal {
  const next = { ...journal, phase, ...(nextHash ? { nextHash } : {}) },
    path = databaseSwitchJournalPath(journal.configFile)
  writePlatformPrivateFile(path, JSON.stringify(next) + '\n', readPlatformPrivateFile(path))
  return next
}

/** Root may request rollback only while it still owns this operation's admission. */
export async function recoverManagedDatabaseSwitch(configFile: string, dataRoot: string, maintenanceFile: string, operation: string) {
  configFile = join(realpathSync(dirname(configFile)), basename(configFile))
  dataRoot = realpathSync(dataRoot)
  maintenanceFile = join(realpathSync(dirname(maintenanceFile)), basename(maintenanceFile))
  const lock = new PlatformLock(dataRoot)
  try {
    const current = FilePlatformDatabaseConfig.open(configFile, dataRoot)
    assertManagedMarker(maintenanceFile, operation, current.deploymentId!)
    const journal = readDatabaseSwitchJournal(configFile, dataRoot)
    if (journal) {
      if (journal.managedOperation !== operation || journal.maintenanceFile !== maintenanceFile || journal.marker !== readFileSync(maintenanceFile, 'utf8'))
        throw Error('The database rollback owner changed')
      rollbackDatabaseSwitch(journal)
    }
    const restored = FilePlatformDatabaseConfig.open(configFile, dataRoot)
    return {
      status: 'rolled-back' as const,
      operation,
      deploymentId: restored.deploymentId!,
      fingerprint: restored.security.registry.masterFingerprint,
      selection: restored.selection!,
    }
  } finally {
    lock.close()
  }
}
export async function finalizeManagedDatabaseSwitch(configFile: string, dataRoot: string, maintenanceFile: string, operation: string) {
  configFile = join(realpathSync(dirname(configFile)), basename(configFile))
  dataRoot = realpathSync(dataRoot)
  maintenanceFile = join(realpathSync(dirname(maintenanceFile)), basename(maintenanceFile))
  const lock = new PlatformLock(dataRoot)
  try {
    const current = FilePlatformDatabaseConfig.open(configFile, dataRoot)
    assertManagedMarker(maintenanceFile, operation, current.deploymentId!)
    const journal = readDatabaseSwitchJournal(configFile, dataRoot)
    if (journal) {
      if (
        journal.managedOperation !== operation ||
        journal.maintenanceFile !== maintenanceFile ||
        journal.marker !== readFileSync(maintenanceFile, 'utf8') ||
        !['committed', 'rolled-back'].includes(journal.phase)
      )
        throw Error('The database finalization owner changed')
      clearDatabaseSwitch(journal)
    }
    return { status: 'acknowledged' as const, operation }
  } finally {
    lock.close()
  }
}
function assertManagedMarker(path: string, operation: string, deploymentId: string): void {
  const file = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const stat = fstatSync(file)
    if (!stat.isFile() || stat.size > 4096) throw Error('Invalid managed database admission carrier')
    const value = JSON.parse(readFileSync(file, 'utf8')) as { schema?: number; operation?: string; operationKind?: string; deploymentId?: string }
    if (value.schema !== 1 || value.operation !== operation || value.operationKind !== 'database-switch' || value.deploymentId !== deploymentId)
      throw Error('Managed database admission does not match its deployment')
  } finally {
    closeSync(file)
  }
}
