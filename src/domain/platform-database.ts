import { BusinessRuleError } from './business-error.js'
/** Private in-process connection settings; never an administration response. */
export interface PlatformDatabaseConnection {
  readonly host: string
  readonly port: number
  readonly database: string
  readonly username: string
  readonly password: string
  readonly tls: 'disable' | 'require' | 'verify-full'
  readonly ca?: string
}

export class PlatformDatabaseError extends Error {
  constructor(
    readonly code: 'unavailable' | 'schema-incompatible' | 'query-failed' | 'deployment-in-use' | 'deployment-mismatch',
    message: string,
    readonly sqlState?: string,
  ) {
    super(message)
    this.name = 'PlatformDatabaseError'
  }
}

/** Local installer/user-unit operations; no secret material is accepted as an argument. */
export type PlatformDatabaseSetupCommand =
  | { readonly kind: 'database-initialize'; readonly configFile: string; readonly masterKeyPath: string; readonly dataRoot: string; readonly port: number }
  | {
      readonly kind: 'database-password-file'
      readonly maintenanceFile?: string
      readonly configFile: string
      readonly dataRoot: string
      readonly output: string
    }
  | { readonly kind: 'database-wait'; readonly maintenanceFile?: string; readonly configFile: string; readonly dataRoot: string }

export type DatabaseCheckStage = 'connection' | 'version' | 'owner' | 'schema'
export interface DatabaseInspection {
  readonly code?: 'deployment-mismatch' | 'master-key-mismatch' | 'unavailable'
  readonly ok: boolean
  readonly checks: readonly { readonly stage: DatabaseCheckStage; readonly passed: boolean }[]
  readonly schema?: 'empty' | 'platform'
  readonly serverVersion?: string
}

/** Untrusted first-install input; diagnostics never include submitted connection values. */
export function requestedPlatformDatabaseConnection(input: {
  host: string
  port: string
  database: string
  username: string
  password: string
  tls: string
  ca: string
}): PlatformDatabaseConnection {
  const port = Number(input.port),
    tls = input.tls
  if (
    ![input.host, input.database, input.username].every(
      value => value.trim().length > 0 && value.length <= 1024 && ![...value].some(character => character.charCodeAt(0) < 32),
    ) ||
    !Number.isSafeInteger(port) ||
    port < 1 ||
    port > 65535 ||
    !/^[0-9]+$/u.test(input.port) ||
    input.password.length > 16384 ||
    input.password.includes('\0') ||
    input.ca.length > 16384 ||
    (tls !== 'disable' && tls !== 'require' && tls !== 'verify-full')
  )
    throw new BusinessRuleError('invalid', 'Invalid platform database connection fields', 'database-connection-invalid')
  return {
    host: input.host.trim(),
    port,
    database: input.database,
    username: input.username,
    password: input.password,
    tls,
    ...(input.ca.trim() ? { ca: input.ca } : {}),
  }
}
