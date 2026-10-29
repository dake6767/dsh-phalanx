import { dirname, join } from 'node:path'
import { closeSync, constants, copyFileSync, existsSync, fchmodSync, fstatSync, ftruncateSync, openSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { setTimeout } from 'node:timers/promises'
import { PlatformDatabaseError } from '../domain/platform-database.js'
import { FilePlatformDatabaseConfig } from './platform-database-config.js'
import { FilePlatformSecrets } from './platform-secrets.js'
import { readPlatformDatabaseState } from './platform-database-inspection.js'
import { readPlatformRecoveryPasswords } from './platform-key-recovery-input.js'
import { prepareBuiltinDatabaseKey } from './platform-key-recovery.js'

/** Installer and user-unit bootstrap: secrets never travel in command arguments or environment. */
export function initializeBuiltinDatabase(configFile: string, masterKeyPath: string, dataRoot: string, port: number) {
  if (!existsSync(configFile)) {
    if (existsSync(masterKeyPath)) throw Error('Incomplete database configuration; restore the matching connection file before continuing')
    FilePlatformDatabaseConfig.create(configFile, masterKeyPath, {
      host: '127.0.0.1',
      port,
      database: 'dsh_phalanx',
      username: 'phalanx',
      password: FilePlatformSecrets.randomCredential(),
      tls: 'disable',
    })
  }
  const builtin = join(dirname(configFile), 'builtin-database.json')
  if (!existsSync(builtin)) {
    if (FilePlatformDatabaseConfig.open(configFile, dataRoot).selection !== undefined)
      throw Error('Built-in database configuration is missing; restore it before retrying installation')
    copyFileSync(configFile, builtin, constants.COPYFILE_EXCL)
  }
  const saved = FilePlatformDatabaseConfig.open(builtin, dataRoot)
  return { masterKeyPath: saved.security.masterKeyPath, fingerprint: saved.security.registry.masterFingerprint, port: saved.connection.port }
}
export function writeBuiltinDatabasePassword(configFile: string, dataRoot: string, output: string, maintenanceFile = '/etc/dsh-phalanx/maintenance'): void {
  prepareBuiltinDatabaseKey(configFile, dataRoot)
  const password = builtinStartupConnection(configFile, dataRoot, maintenanceFile).password
  const descriptor = openSync(output, constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600)
  try {
    if (!fstatSync(descriptor).isFile()) throw Error('Database password output must be a regular private runtime file')
    fchmodSync(descriptor, 0o600)
    ftruncateSync(descriptor, 0)
    // The runtime directory is owned by the service identity and is removed on logout/reboot.
    writeFileSync(descriptor, password)
  } finally {
    closeSync(descriptor)
  }
}
export async function waitForPlatformDatabase(configFile: string, dataRoot: string, maintenanceFile = '/etc/dsh-phalanx/maintenance') {
  const connection = builtinStartupConnection(configFile, dataRoot, maintenanceFile),
    deadline = Date.now() + 60_000
  for (;;) {
    try {
      const status = await readPlatformDatabaseState(connection)
      return {
        state: 'connected' as const,
        schemaVersion: status.schemaVersion,
        serverVersion: status.serverVersion,
        address: `${connection.host}:${connection.port}/${connection.database}`,
      }
    } catch (error) {
      if (!(error instanceof PlatformDatabaseError) || error.code !== 'unavailable' || Date.now() >= deadline) throw error
    }
    await setTimeout(100)
  }
}

/** Normal startup still authenticates the master; only a confirmed root reset can recover transport. */
function builtinStartupConnection(configFile: string, dataRoot: string, maintenanceFile: string) {
  try {
    return FilePlatformDatabaseConfig.open(configFile, dataRoot).connection
  } catch (error) {
    const password = managedResetPassword(configFile, dataRoot, maintenanceFile, error)
    return { ...FilePlatformDatabaseConfig.readProtected(configFile, dataRoot).connection, password }
  }
}

/** Only a root-issued, deployment-bound reset may bootstrap PG without the missing master. */
function managedResetPassword(configFile: string, dataRoot: string, maintenanceFile: string, originalError: unknown): string {
  let file: number
  try {
    file = openSync(maintenanceFile, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  } catch {
    throw originalError
  }
  try {
    const stat = fstatSync(file)
    if (!stat.isFile() || stat.uid !== 0 || (stat.mode & 0o022) !== 0 || stat.size > 4096) throw originalError
    const marker = JSON.parse(readFileSync(file, 'utf8')) as { schema?: number; operationKind?: string; operation?: string; deploymentId?: string }
    const saved = FilePlatformDatabaseConfig.readProtected(configFile, dataRoot)
    if (
      marker.schema !== 1 ||
      marker.operationKind !== 'master-key-reset' ||
      !/^[a-f0-9-]{36}$/u.test(marker.operation ?? '') ||
      marker.deploymentId !== saved.deploymentId ||
      configFile !== join(dirname(configFile), 'builtin-database.json')
    )
      throw originalError
    return readPlatformRecoveryPasswords(join(dirname(configFile), 'secret-recovery.json'), dataRoot, statSync(configFile).uid).builtinPassword
  } finally {
    closeSync(file)
  }
}
