import { closeSync, constants, existsSync, fstatSync, fsyncSync, openSync, readFileSync, realpathSync, renameSync, rmSync, statSync } from 'node:fs'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import type { RotationJournal } from '../domain/platform-key-operation.js'
import type { PlatformSecretRegistry } from '../domain/platform-secret.js'
import { FilePlatformDatabaseConfig } from './platform-database-config.js'
import { PlatformDatabaseMaintenance } from './platform-database-maintenance.js'
import { FilePlatformSecrets } from './platform-secrets.js'
import { resetPlatformDatabaseSecrets } from './platform-secret-reset.js'
import { platformFileExists } from './platform-private-file.js'
import { PlatformLock } from './platform-lock.js'

export const platformKeyJournalPath = (configFile: string) => join(dirname(configFile), 'platform-key-operation.json')

/** Caller holds the local platform lock. This phase also works before PostgreSQL starts. */
export function preparePlatformKeyRecovery(configFile: string, dataRoot: string): RotationJournal | undefined {
  configFile = join(realpathSync(dirname(configFile)), basename(configFile))
  dataRoot = realpathSync(dataRoot)
  const journal = readPlatformKeyJournal(configFile, dataRoot)
  if (!journal) return undefined
  if (journal.phase === 'preparing') {
    for (const file of journal.configurations) {
      const saved = FilePlatformDatabaseConfig.readProtected(file.path, dataRoot)
      if (saved.deploymentId !== journal.deploymentId || !isDeepStrictEqual(saved.registry, file.registry))
        throw Error('Uncommitted key configuration changed during preparation')
    }
    for (const path of [journal.master.staged, ...journal.configurations.map(file => file.staged)]) rmSync(path, { force: true })
    clearPlatformKeyOperation(journal)
    return undefined
  }
  const master = existsSync(journal.master.staged) ? journal.master.staged : journal.master.path
  for (const source of journal.sources) FilePlatformSecrets.open(master, source.registry).close()
  if (existsSync(journal.master.staged)) {
    renameSync(journal.master.staged, journal.master.path)
    syncDirectory(dirname(journal.master.path))
  }
  for (const file of journal.configurations) {
    const target = existsSync(file.staged) ? file.staged : file.path
    const saved = FilePlatformDatabaseConfig.open(target, dataRoot)
    if (
      saved.deploymentId !== journal.deploymentId ||
      saved.security.masterKeyPath !== journal.master.path ||
      !isDeepStrictEqual(saved.security.registry, file.registry)
    )
      throw Error('Pending key configuration does not match its protected operation')
    if (target === file.staged) {
      renameSync(file.staged, file.path)
      syncDirectory(dirname(file.path))
    }
  }
  return journal
}

/** The user-unit password hook runs before production acquires its own local lock. */
export function prepareBuiltinDatabaseKey(configFile: string, dataRoot: string): void {
  if (!existsSync(platformKeyJournalPath(configFile))) return
  const lock = new PlatformLock(dataRoot)
  try {
    preparePlatformKeyRecovery(configFile, dataRoot)
  } finally {
    lock.close()
  }
}

/** Caller holds the local lock; finish every database before claiming production ownership. */
export async function finishPlatformKeyRecovery(configFile: string, dataRoot: string): Promise<string | undefined> {
  const journal = preparePlatformKeyRecovery(configFile, dataRoot)
  if (!journal) return undefined
  if (journal.phase !== 'prepared') throw Error('Platform key recovery has not reached its prepared phase')
  const sessions: PlatformDatabaseMaintenance[] = []
  const failures: unknown[] = []
  try {
    for (const source of journal.sources) {
      const saved = FilePlatformDatabaseConfig.open(source.configFile, dataRoot)
      const session = await PlatformDatabaseMaintenance.open(
        saved.connection,
        source.registry.masterFingerprint,
        journal.deploymentId,
        source.oldRegistry.masterFingerprint,
      )
      sessions.push(session)
      if (source.platform) {
        if (session.schema !== 'platform') throw Error('A retained platform database disappeared during key recovery')
        const current = (await session.query<{ registry: PlatformSecretRegistry }>('SELECT registry FROM dsh_phalanx.platform_security WHERE id=1'))[0]!
          .registry
        if (isDeepStrictEqual(current, source.registry)) continue
        if (!isDeepStrictEqual(current, source.oldRegistry)) throw Error('Platform key registry changed outside the pending operation')
        if (journal.kind === 'reset') {
          await resetPlatformDatabaseSecrets(session, journal.master.path, source.oldRegistry, source.registry)
          continue
        }
        const updated = await session.query('UPDATE dsh_phalanx.platform_security SET registry=$1 WHERE id=1 AND registry=$2::jsonb RETURNING id', [
          JSON.stringify(source.registry),
          JSON.stringify(source.oldRegistry),
        ])
        if (updated.length !== 1) throw Error('Platform key registry changed during recovery')
      } else if (session.schema !== 'empty') throw Error('The previously empty built-in database changed during key recovery')
    }
  } catch (error) {
    failures.push(error)
  }
  const closed = await Promise.allSettled(sessions.map(session => session.close()))
  failures.push(...closed.flatMap(result => (result.status === 'rejected' ? [result.reason] : [])))
  if (failures.length === 1) throw failures[0]
  if (failures.length) throw new AggregateError(failures, 'Platform key recovery and connection cleanup failed')
  clearPlatformKeyOperation(journal)
  return journal.sources[0]!.registry.masterFingerprint
}

export function clearPlatformKeyOperation(journal: RotationJournal): void {
  if (journal.managedOperation) {
    // The root coordinator owns admission and acknowledges the prepared journal.
    if (journal.phase === 'preparing') {
      rmSync(platformKeyJournalPath(journal.configFile))
      syncDirectory(dirname(journal.configFile))
    }
    return
  }
  // Marker first: a crash afterwards leaves a journal that startup can replay.
  if (platformFileExists(journal.maintenanceFile)) {
    const file = openSync(journal.maintenanceFile, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const stat = fstatSync(file)
      if (!stat.isFile() || stat.size > 1024 || readFileSync(file, 'utf8') !== journal.marker) throw Error('Maintenance marker ownership changed')
    } finally {
      closeSync(file)
    }
    rmSync(journal.maintenanceFile)
    syncDirectory(dirname(journal.maintenanceFile))
  }
  rmSync(platformKeyJournalPath(journal.configFile))
  syncDirectory(dirname(journal.configFile))
}

export function readPlatformKeyJournal(configFile: string, dataRoot: string): RotationJournal | undefined {
  const path = platformKeyJournalPath(configFile)
  if (!platformFileExists(path)) return undefined
  const file = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  let input: unknown
  try {
    const stat = fstatSync(file)
    if (!stat.isFile() || (stat.mode & 0o777) !== 0o600 || stat.uid !== statSync(configFile).uid || stat.size > 262144)
      throw Error('Platform key operation must be a protected regular 0600 file')
    try {
      input = JSON.parse(readFileSync(file, 'utf8'))
    } catch {
      throw Error('The pending platform key operation is not valid protected JSON')
    }
  } finally {
    closeSync(file)
  }
  const journal = input as RotationJournal,
    builtin = join(dirname(configFile), 'builtin-database.json')
  const invalid = () => Error('The pending platform key operation is invalid; restore its protected configuration')
  if (
    !journal ||
    journal.version !== 1 ||
    !['rotate', 'reset'].includes(journal.kind) ||
    !['preparing', 'prepared'].includes(journal.phase) ||
    typeof journal.configFile !== 'string' ||
    dirname(journal.configFile) !== dirname(configFile) ||
    ![journal.configFile, builtin].includes(configFile) ||
    journal.dataRoot !== dataRoot ||
    typeof journal.deploymentId !== 'string' ||
    typeof journal.maintenanceFile !== 'string' ||
    !isAbsolute(journal.maintenanceFile) ||
    typeof journal.marker !== 'string' ||
    journal.marker.length > 1024 ||
    !journal.master ||
    typeof journal.master.path !== 'string' ||
    typeof journal.master.staged !== 'string' ||
    !Array.isArray(journal.configurations) ||
    journal.configurations.length !== 2 ||
    !Array.isArray(journal.sources) ||
    journal.sources.length < 1 ||
    journal.sources.length > 2
  )
    throw invalid()
  if (
    journal.managedOperation !== undefined &&
    (typeof journal.managedOperation !== 'string' ||
      !/^[a-f0-9-]{36}$/u.test(journal.managedOperation) ||
      JSON.parse(journal.marker).operation !== journal.managedOperation)
  )
    throw invalid()
  const original = FilePlatformDatabaseConfig.readProtected(configFile, dataRoot)
  if (
    journal.master.path !== original.masterKeyPath ||
    journal.deploymentId !== original.deploymentId ||
    journal.master.staged.slice(0, journal.master.path.length) !== journal.master.path ||
    !/^\.next-[a-f0-9-]{36}$/u.test(journal.master.staged.slice(journal.master.path.length))
  )
    throw invalid()
  const paths = [journal.configFile, join(dirname(journal.configFile), 'builtin-database.json')]
  if (
    new Set(journal.configurations.map(row => row.path)).size !== 2 ||
    journal.configurations.some(
      row =>
        !paths.includes(row.path) ||
        typeof row.staged !== 'string' ||
        !row.staged.startsWith(row.path) ||
        !/^\.tmp-key-[a-f0-9-]{36}$/u.test(row.staged.slice(row.path.length)),
    )
  )
    throw invalid()
  if (
    new Set(journal.sources.map(row => row.configFile)).size !== journal.sources.length ||
    journal.sources[0]?.configFile !== journal.configFile ||
    journal.sources.some(row => !paths.includes(row.configFile) || typeof row.platform !== 'boolean' || !row.oldRegistry) ||
    (journal.phase === 'prepared' && journal.sources.some(row => !row.registry))
  )
    throw invalid()
  if (realpathSync(dirname(journal.configFile)) !== realpathSync(dirname(configFile))) throw invalid()
  return journal
}
function syncDirectory(path: string): void {
  const directory = openSync(path, constants.O_RDONLY)
  try {
    fsyncSync(directory)
  } finally {
    closeSync(directory)
  }
}
