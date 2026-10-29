import { FilePlatformDatabaseConfig } from './platform-database-config.js'
import { randomUUID } from 'node:crypto'
import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type { PlatformSecretRegistry } from '../domain/platform-secret.js'
import type { RotationJournal, RotationSource } from '../domain/platform-key-operation.js'
import { clearPlatformKeyOperation, finishPlatformKeyRecovery, readPlatformKeyJournal } from './platform-key-recovery.js'
import { FilePlatformSecrets } from './platform-secrets.js'
import { PlatformLock } from './platform-lock.js'
import { readPlatformRecoveryPasswords } from './platform-key-recovery-input.js'
import { resetPlatformDatabaseSecrets } from './platform-secret-reset.js'
import { PlatformDatabaseMaintenance } from './platform-database-maintenance.js'

/** Read-only operator metadata; opening the protected configuration authenticates its key. */
export function platformKeyFingerprint(configFile: string, dataRoot: string) {
  const saved = FilePlatformDatabaseConfig.open(configFile, dataRoot)
  return { fingerprint: saved.security.registry.masterFingerprint, masterKeyPath: saved.security.masterKeyPath }
}

interface ResetInput {
  readonly activePassword: string
  readonly builtinPassword: string
}
export async function resetPlatformKey(
  configFile: string,
  dataRoot: string,
  maintenanceFile: string,
  recoveryFile: string,
  confirmation: string,
  managedOperation?: string,
) {
  if (confirmation !== 'RESET ALL PLATFORM SECRETS') throw Error('Reset requires the exact confirmation: RESET ALL PLATFORM SECRETS')
  return operatePlatformKey(configFile, dataRoot, maintenanceFile, managedOperation, () => readPlatformRecoveryPasswords(recoveryFile, dataRoot))
}

/** Offline operations never construct the production graph or reuse its decrypted caches. */
export async function rotatePlatformKey(configFile: string, dataRoot: string, maintenanceFile: string, managedOperation?: string) {
  return operatePlatformKey(configFile, dataRoot, maintenanceFile, managedOperation)
}
async function operatePlatformKey(configFile: string, dataRoot: string, maintenanceFile: string, managedOperation?: string, reset?: () => ResetInput) {
  configFile = join(realpathSync(dirname(configFile)), basename(configFile))
  dataRoot = realpathSync(dataRoot)
  maintenanceFile = join(realpathSync(dirname(maintenanceFile)), basename(maintenanceFile))
  if (statSync(configFile).uid !== process.getuid?.()) throw Error('Run offline maintenance as the configuration owner')
  if (!statSync(dataRoot).isDirectory()) throw Error('Maintenance requires an existing platform data root')
  const lock = new PlatformLock(dataRoot),
    journalPath = join(dirname(configFile), 'platform-key-operation.json')
  try {
    if (existsSync(journalPath)) {
      const journal = readPlatformKeyJournal(configFile, dataRoot)!
      if (journal.managedOperation !== managedOperation || journal.kind !== (reset ? 'reset' : 'rotate'))
        throw Error('A different maintenance operation must be recovered first')
      const fingerprint = await finishPlatformKeyRecovery(configFile, dataRoot)
      if (fingerprint)
        return { status: 'recovered' as const, fingerprint, ...(managedOperation ? { operation: managedOperation, deploymentId: journal.deploymentId } : {}) }
    }
    return await performRotation(configFile, dataRoot, maintenanceFile, journalPath, managedOperation, reset?.())
  } finally {
    lock.close()
  }
}

async function performRotation(
  configFile: string,
  dataRoot: string,
  maintenanceFile: string,
  journalPath: string,
  managedOperation?: string,
  reset?: ResetInput,
) {
  const sessions: PlatformDatabaseMaintenance[] = [],
    staged: string[] = []
  const failures: unknown[] = []
  const marker = managedOperation ? readFileSync(maintenanceFile, 'utf8') : JSON.stringify({ kind: 'platform-key-rotate', id: randomUUID() }) + '\n'
  if (managedOperation) {
    const value = JSON.parse(marker) as { schema?: number; operation?: string }
    if (value.schema !== 1 || value.operation !== managedOperation) throw Error('Managed admission marker does not match this operation')
  }
  let marked = false,
    journaled = false,
    completed = false,
    fingerprint = ''
  let intent: RotationJournal | undefined
  try {
    const load = (path: string, password?: string) => {
      if (!reset) return FilePlatformDatabaseConfig.open(path, dataRoot)
      const value = FilePlatformDatabaseConfig.readProtected(path, dataRoot)
      return { ...value, security: { masterKeyPath: value.masterKeyPath, registry: value.registry }, connection: { ...value.connection, password: password! } }
    }
    const active = load(configFile, reset?.activePassword),
      builtinFile = join(dirname(configFile), 'builtin-database.json')
    const builtin = load(builtinFile, reset?.builtinPassword)
    if (managedOperation) {
      const admission = JSON.parse(marker) as { operationKind?: string; deploymentId?: string }
      if (admission.operationKind !== (reset ? 'master-key-reset' : 'master-key-rotate') || admission.deploymentId !== active.deploymentId)
        throw Error('Managed admission does not match this deployment and operation kind')
    }
    if (!active.selection || !active.deploymentId || builtin.security.masterKeyPath !== active.security.masterKeyPath)
      throw Error('Maintenance requires a selected database and matching protected built-in configuration')
    const first = await PlatformDatabaseMaintenance.open(active.connection, active.security.registry.masterFingerprint, active.deploymentId)
    sessions.push(first)
    if (first.schema !== 'platform') throw Error('The selected platform database is not initialized')
    const same = await first.isSameDatabase(builtin.connection)
    const second = same ? first : await PlatformDatabaseMaintenance.open(builtin.connection, builtin.security.registry.masterFingerprint, active.deploymentId)
    if (!same) sessions.push(second)
    const nextMaster = active.security.masterKeyPath + '.next-' + randomUUID()
    const targets = [
      [configFile, active, first],
      [builtinFile, builtin, second],
    ] as const
    const oldRegistries: PlatformSecretRegistry[] = []
    for (const [, saved, database] of targets)
      oldRegistries.push(
        database.schema === 'platform'
          ? (await database.query<{ registry: PlatformSecretRegistry }>('SELECT registry FROM dsh_phalanx.platform_security WHERE id=1'))[0]!.registry
          : saved.security.registry,
      )
    const plans = targets.map(([path, saved]) => ({ path, staged: path + '.tmp-key-' + randomUUID(), registry: saved.security.registry }))
    for (const path of [...(managedOperation ? [] : [maintenanceFile]), nextMaster, ...plans.map(plan => plan.staged)]) {
      try {
        lstatSync(path)
        throw Error('A planned private staging path already exists')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
    const preparing: RotationJournal = {
      version: 1,
      kind: reset ? 'reset' : 'rotate',
      phase: 'preparing',
      deploymentId: active.deploymentId,
      configFile,
      dataRoot,
      maintenanceFile,
      marker,
      ...(managedOperation ? { managedOperation } : {}),
      master: { path: active.security.masterKeyPath, staged: nextMaster },
      configurations: plans,
      sources: targets.flatMap(([path, , database], index) =>
        index === 0 || database !== first ? [{ configFile: path, oldRegistry: oldRegistries[index]!, platform: database.schema === 'platform' }] : [],
      ),
    }
    intent = preparing
    writePrivate(journalPath, JSON.stringify(preparing) + '\n')
    journaled = true
    if (!managedOperation) {
      writePrivate(maintenanceFile, marker)
      marked = true
    }
    const current = reset ? FilePlatformSecrets.create(nextMaster) : FilePlatformSecrets.open(active.security.masterKeyPath, oldRegistries[0]!)
    let registry: PlatformSecretRegistry
    try {
      registry = reset ? current.registry() : current.rewrap(nextMaster)
    } finally {
      current.close()
    }
    staged.push(nextMaster)
    fingerprint = registry.masterFingerprint
    const configurations: { path: string; staged: string; registry: PlatformSecretRegistry }[] = [],
      sources: RotationSource[] = []
    for (const [index, [path, saved, database]] of targets.entries()) {
      const oldRegistry = oldRegistries[index]!
      let next: PlatformSecretRegistry = registry
      if (!reset) {
        const secrets = FilePlatformSecrets.open(saved.security.masterKeyPath, oldRegistry)
        try {
          next = database === first ? registry : secrets.rewrapTo(nextMaster)
        } finally {
          secrets.close()
        }
      }
      const pathNext = reset
        ? FilePlatformDatabaseConfig.stageReset(
            path,
            dataRoot,
            nextMaster,
            next,
            index === 0 ? reset.activePassword : reset.builtinPassword,
            plans[index]!.staged,
          )
        : FilePlatformDatabaseConfig.stageRegistry(path, dataRoot, nextMaster, next, plans[index]!.staged)
      staged.push(pathNext)
      configurations.push({ path, staged: pathNext, registry: next })
      if (!sources.some(source => source.configFile === configFile && database === first))
        sources.push({ configFile: path, oldRegistry, registry: next, platform: database.schema === 'platform' })
    }
    const journal: RotationJournal = {
      version: 1,
      kind: reset ? 'reset' : 'rotate',
      phase: 'prepared',
      deploymentId: active.deploymentId,
      configFile,
      dataRoot,
      maintenanceFile,
      marker,
      ...(managedOperation ? { managedOperation } : {}),
      master: { path: active.security.masterKeyPath, staged: nextMaster },
      configurations,
      sources,
    }
    intent = journal
    writePrivate(journalPath, JSON.stringify(journal) + '\n', JSON.stringify(preparing) + '\n')
    for (let index = 0; index < sources.length; index++) {
      const source = sources[index]!,
        database = sessions[index]!
      if (source.platform && reset) await resetPlatformDatabaseSecrets(database, nextMaster, source.oldRegistry, source.registry)
      else if (source.platform) {
        const updated = await database.query('UPDATE dsh_phalanx.platform_security SET registry=$1 WHERE id=1 AND registry=$2::jsonb RETURNING id', [
          JSON.stringify(source.registry),
          JSON.stringify(source.oldRegistry),
        ])
        if (updated.length !== 1) throw Error('Platform key registry changed during maintenance; recovery is required')
      }
    }
    renameSync(nextMaster, journal.master.path)
    syncDirectory(dirname(journal.master.path))
    for (const file of configurations) {
      renameSync(file.staged, file.path)
      syncDirectory(dirname(file.path))
    }
    completed = true
  } catch (error) {
    journaled ||= intent !== undefined && existsSync(journalPath)
    failures.push(error)
  }
  const closed = await Promise.allSettled(sessions.map(database => database.close()))
  failures.push(...closed.flatMap(result => (result.status === 'rejected' ? [result.reason] : [])))
  try {
    if (completed && !failures.length) clearPlatformKeyOperation(intent!)
    if (!journaled) for (const path of staged) rmSync(path, { force: true })
    if (marked && !journaled) {
      if (readFileSync(maintenanceFile, 'utf8') !== marker) throw Error('Maintenance marker ownership changed')
      rmSync(maintenanceFile)
      syncDirectory(dirname(maintenanceFile))
    }
  } catch (error) {
    failures.push(error)
  }
  if (failures.length === 1) throw failures[0]
  if (failures.length) throw new AggregateError(failures, 'Platform key maintenance and cleanup failed; keep maintenance closed')
  return {
    status: reset ? ('reset' as const) : ('rotated' as const),
    fingerprint,
    ...(managedOperation ? { operation: managedOperation, deploymentId: intent!.deploymentId } : {}),
  }
}

function writePrivate(path: string, value: string, previous?: string): void {
  const staging = path + '.tmp-' + randomUUID()
  const file = openSync(staging, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  try {
    writeFileSync(file, value)
    fsyncSync(file)
    if (previous === undefined) linkSync(staging, path)
    else {
      const current = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
      try {
        if (readFileSync(current, 'utf8') !== previous) throw Error('Protected operation ownership changed')
      } finally {
        closeSync(current)
      }
      renameSync(staging, path)
    }
    syncDirectory(dirname(path))
  } finally {
    closeSync(file)
    rmSync(staging, { force: true })
  }
}
function syncDirectory(path: string): void {
  const directory = openSync(path, constants.O_RDONLY)
  try {
    fsyncSync(directory)
  } finally {
    closeSync(directory)
  }
}
