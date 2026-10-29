import { randomUUID } from 'node:crypto'
import { closeSync, constants, fstatSync, fsyncSync, openSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import type { PlatformDatabaseConnection } from '../domain/platform-database.js'
import type { PlatformSecretEnvelope, PlatformSecretRegistry } from '../domain/platform-secret.js'
import { FilePlatformSecrets } from './platform-secrets.js'

interface SavedDatabaseConfiguration {
  readonly deploymentId?: string
  readonly selection?: 'builtin' | 'external'
  readonly version: 1
  readonly masterKeyPath: string
  readonly registry: PlatformSecretRegistry
  readonly connection: Omit<PlatformDatabaseConnection, 'password'> & { readonly password: PlatformSecretEnvelope }
}
const context = { table: 'platform_database', recordId: 'connection', field: 'password' }
/** Local bootstrap configuration; only its password is decrypted in platform memory. */
export class FilePlatformDatabaseConfig {
  static create(path: string, masterKeyPath: string, connection: PlatformDatabaseConnection): void {
    const secrets = FilePlatformSecrets.create(masterKeyPath)
    try {
      const value: SavedDatabaseConfiguration = {
        version: 1,
        deploymentId: randomUUID(),
        masterKeyPath,
        registry: secrets.registry(),
        connection: { ...connection, password: secrets.encrypt(context, connection.password) },
      }
      writeFileSync(path, JSON.stringify(value) + '\n', { mode: 0o600, flag: 'wx' })
    } finally {
      secrets.close()
    }
  }
  /** First-install selection is durable before any owner starts writing business data. */
  static select(path: string, dataRoot: string, connection: PlatformDatabaseConnection, selection: 'builtin' | 'external'): void {
    const saved = this.open(path, dataRoot)
    if (saved.selection !== undefined) throw Error('Platform database selection is already committed')
    const secrets = FilePlatformSecrets.open(saved.security.masterKeyPath, saved.security.registry)
    const staging = path + '.tmp-' + randomUUID()
    try {
      const value: SavedDatabaseConfiguration = {
        version: 1,
        deploymentId: saved.deploymentId ?? randomUUID(),
        selection,
        masterKeyPath: saved.security.masterKeyPath,
        registry: saved.security.registry,
        connection: { ...connection, password: secrets.encrypt(context, connection.password) },
      }
      const descriptor = openSync(staging, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
      try {
        writeFileSync(descriptor, JSON.stringify(value) + '\n')
        fsyncSync(descriptor)
      } finally {
        closeSync(descriptor)
      }
      // Apply the same permission, location and connection checks before committing the new file.
      this.open(staging, dataRoot)
      renameSync(staging, path)
      const directory = openSync(dirname(path), constants.O_RDONLY)
      try {
        fsyncSync(directory)
      } finally {
        closeSync(directory)
      }
    } finally {
      secrets.close()
      rmSync(staging, { force: true })
    }
  }
  /** Protected file structure is available to recovery before the master is replaced. */
  static readProtected(path: string, dataRoot: string): SavedDatabaseConfiguration {
    const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    let input: unknown
    try {
      const stat = fstatSync(descriptor)
      if (!stat.isFile() || (stat.mode & 0o777) !== 0o600 || stat.size > 65536) throw Error('Platform database configuration must be a regular 0600 file')
      input = JSON.parse(readFileSync(descriptor, 'utf8'))
    } finally {
      closeSync(descriptor)
    }
    const invalid = () => Error('Platform database configuration is invalid')
    if (!input || typeof input !== 'object') throw invalid()
    const value = input as SavedDatabaseConfiguration,
      connection = value.connection
    if (
      value.version !== 1 ||
      (value.deploymentId !== undefined && (typeof value.deploymentId !== 'string' || !/^[a-f0-9-]{36}$/u.test(value.deploymentId))) ||
      (value.selection !== undefined && !['builtin', 'external'].includes(value.selection)) ||
      typeof value.masterKeyPath !== 'string' ||
      !isAbsolute(value.masterKeyPath) ||
      !connection ||
      typeof connection !== 'object' ||
      !['host', 'database', 'username'].every(key => typeof connection[key as 'host'] === 'string' && connection[key as 'host'].length > 0) ||
      !Number.isSafeInteger(connection.port) ||
      connection.port < 1 ||
      connection.port > 65535 ||
      !['disable', 'require', 'verify-full'].includes(connection.tls) ||
      (connection.ca !== undefined && typeof connection.ca !== 'string') ||
      !connection.password ||
      typeof connection.password !== 'object'
    )
      throw invalid()
    const root = realpathSync(dataRoot)
    for (const target of [realpathSync(path), resolve(realpathSync(dirname(value.masterKeyPath)), value.masterKeyPath.split('/').at(-1)!)]) {
      const inside = relative(root, target)
      if (inside === '' || (inside !== '..' && !inside.startsWith('..' + sep) && !isAbsolute(inside)))
        throw Error('Platform database configuration and master key must be outside the data root')
    }
    return value
  }
  /** Stage only a registry replacement; the existing connection ciphertext is preserved. */
  static stageRegistry(
    path: string,
    dataRoot: string,
    nextMasterPath: string,
    registry: PlatformSecretRegistry,
    staging = path + '.tmp-key-' + randomUUID(),
  ): string {
    const value = this.readProtected(path, dataRoot),
      next = FilePlatformSecrets.open(nextMasterPath, registry)
    const original = this.open(path, dataRoot)
    try {
      if (next.decrypt(context, value.connection.password) !== original.connection.password) throw Error('Rewrapped database credential does not match')
      const file = openSync(staging, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
      try {
        writeFileSync(file, JSON.stringify({ ...value, registry }) + '\n')
        fsyncSync(file)
      } finally {
        closeSync(file)
      }
      return staging
    } finally {
      next.close()
    }
  }
  /** A stopped-platform transaction stages a new selection without weakening first-install select(). */
  static stageSelection(
    path: string,
    dataRoot: string,
    connection: PlatformDatabaseConnection,
    selection: 'builtin' | 'external',
    registry: PlatformSecretRegistry,
    staging: string,
  ): string {
    const value = this.readProtected(path, dataRoot),
      secrets = FilePlatformSecrets.open(value.masterKeyPath, registry)
    try {
      const replacement = { ...value, selection, registry, connection: { ...connection, password: secrets.encrypt(context, connection.password) } }
      const file = openSync(staging, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
      try {
        writeFileSync(file, JSON.stringify(replacement) + '\n')
        fsyncSync(file)
      } finally {
        closeSync(file)
      }
      this.open(staging, dataRoot)
      return staging
    } finally {
      secrets.close()
    }
  }
  /** Lost-key recovery replaces only the protected registry and supplied connection password. */
  static stageReset(path: string, dataRoot: string, nextMasterPath: string, registry: PlatformSecretRegistry, password: string, staging: string): string {
    const value = this.readProtected(path, dataRoot),
      next = FilePlatformSecrets.open(nextMasterPath, registry)
    try {
      const replacement = { ...value, registry, connection: { ...value.connection, password: next.encrypt(context, password) } }
      const file = openSync(staging, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
      try {
        writeFileSync(file, JSON.stringify(replacement) + '\n')
        fsyncSync(file)
      } finally {
        closeSync(file)
      }
      return staging
    } finally {
      next.close()
    }
  }
  static open(path: string, dataRoot: string) {
    const value = this.readProtected(path, dataRoot),
      connection = value.connection
    const secrets = FilePlatformSecrets.open(value.masterKeyPath, value.registry)
    try {
      return {
        ...(value.deploymentId ? { deploymentId: value.deploymentId } : {}),
        ...(value.selection ? { selection: value.selection } : {}),
        connection: { ...connection, password: secrets.decrypt(context, connection.password) },
        security: { masterKeyPath: value.masterKeyPath, registry: secrets.registry() },
      }
    } finally {
      secrets.close()
    }
  }
}
