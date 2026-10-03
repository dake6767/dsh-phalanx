import { resolve } from 'node:path'
import { validateCommunityModelCredential, validateCommunityNetworkAddresses, type CommunityConfig } from '../domain/community-config.js'
import { validateConfig } from '../domain/config-validation.js'

type Environment = Readonly<Record<string, string | undefined>>

/** Idle window applied when a deployment sets no explicit value: 30 minutes. */
const DEFAULT_IDLE_RECLAIM_SECONDS = 1800

/** Build validated application configuration from deployment environment variables. */
export function loadCommunityConfig(environment: Environment = process.env): CommunityConfig {
  const sessionSecret = required(environment, 'DSH_PHALANX_SESSION_SECRET')
  const command = required(environment, 'DSH_PHALANX_RUNTIME_COMMAND')
  const args = parseStringArray(required(environment, 'DSH_PHALANX_RUNTIME_ARGS_JSON'), 'DSH_PHALANX_RUNTIME_ARGS_JSON')
  const publicOrigin = optional(environment, 'DSH_PHALANX_PUBLIC_ORIGIN')
  const runtimeEnvironment = parseOptionalRuntimeEnvironment(environment.DSH_PHALANX_RUNTIME_ENV_JSON)
  const patches = parseOptionalStringArray(environment.DSH_PHALANX_RUNTIME_PATCHES_JSON, 'DSH_PHALANX_RUNTIME_PATCHES_JSON')
  const containerImage = optional(environment, 'DSH_PHALANX_CONTAINER_IMAGE')
  const containerArgs = parseOptionalStringArray(environment.DSH_PHALANX_CONTAINER_ARGS_JSON, 'DSH_PHALANX_CONTAINER_ARGS_JSON')
  const container = containerImage === undefined
    ? undefined
    : {
        runtime: optional(environment, 'DSH_PHALANX_CONTAINER_RUNTIME') ?? 'podman',
        image: containerImage,
        internalPort: parseInstancePort(optional(environment, 'DSH_PHALANX_CONTAINER_INTERNAL_PORT') ?? '4180', 'DSH_PHALANX_CONTAINER_INTERNAL_PORT'),
        gatewayPort: parseInstancePort(optional(environment, 'DSH_PHALANX_CONTAINER_GATEWAY_PORT') ?? '3081', 'DSH_PHALANX_CONTAINER_GATEWAY_PORT'),
        ...(containerArgs === undefined ? {} : { extraArgs: containerArgs }),
      }
  const allowedProvider = required(environment, 'DSH_PHALANX_ALLOWED_MODEL_PROVIDER')
  const allowedModel = required(environment, 'DSH_PHALANX_ALLOWED_MODEL')
  const upstreamBaseUrl = required(environment, 'DSH_PHALANX_MODEL_UPSTREAM_BASE_URL')
  const key = optional(environment, 'DSH_PHALANX_MODEL_UPSTREAM_API_KEY')
  const hostAddresses = environment.DSH_PHALANX_HOST_PUBLIC_ADDRESSES
  const idleReclaimSeconds = parseIdleReclaimSeconds(optional(environment, 'DSH_PHALANX_IDLE_RECLAIM_SECONDS')) ?? DEFAULT_IDLE_RECLAIM_SECONDS
  const adminUiRoot = optional(environment, 'DSH_PHALANX_ADMIN_UI_ROOT')

  const config: CommunityConfig = {
    listen: {
      host: optional(environment, 'DSH_PHALANX_HOST') ?? '127.0.0.1',
      port: parsePort(optional(environment, 'DSH_PHALANX_PORT') ?? '3000'),
      ...(publicOrigin === undefined ? {} : { publicOrigin }),
    },
    sessionSecret,
    registration: { enabled: parseRegistration(environment.DSH_PHALANX_REGISTRATION_ENABLED) },
    ...(idleReclaimSeconds === undefined ? {} : { idleReclaimSeconds }),
    ...(adminUiRoot === undefined ? {} : { adminUiRoot }),
    ...(key === undefined ? {} : { modelGateway: { upstreamApiKey: key } }),
    ...(hostAddresses === undefined ? {} : { network: { hostPublicAddresses: hostAddresses.split(',').map(address => address.trim()) } }),
    runtime: {
      command,
      args,
      dataRoot: resolve(optional(environment, 'DSH_PHALANX_DATA_ROOT') ?? '.data'),
      ...(runtimeEnvironment === undefined ? {} : { environment: runtimeEnvironment }),
      ...(patches === undefined ? {} : { patches }),
      ...(container === undefined ? {} : { container }),
      defaultModel: {
        provider: allowedProvider,
        model: allowedModel,
        upstream: { baseUrl: upstreamBaseUrl },
      },
    },
  }
  validateConfig(config)
  validateCommunityModelCredential(config)
  validateCommunityNetworkAddresses(config)
  return config
}

function parseOptionalStringArray(value: string | undefined, name: string): string[] | undefined {
  if (value === undefined || value.trim() === '') return undefined
  return parseStringArray(value, name)
}

function parseStringArray(value: string, name: string): string[] {
  const parsed = parseJson(value, name)
  if (!Array.isArray(parsed) || !parsed.every(item => typeof item === 'string')) {
    throw new Error(`${name} must be a JSON array of strings`)
  }
  return parsed
}

function parseOptionalStringMap(value: string | undefined, name: string): Record<string, string> | undefined {
  if (value === undefined || value.trim() === '') return undefined
  const parsed = parseJson(value, name)
  if (!isRecord(parsed) || !Object.values(parsed).every(item => typeof item === 'string')) {
    throw new Error(`${name} must be a JSON object with string values`)
  }
  return parsed as Record<string, string>
}

function parseOptionalRuntimeEnvironment(value: string | undefined): Record<string, string> | undefined {
  const parsed = parseOptionalStringMap(value, 'DSH_PHALANX_RUNTIME_ENV_JSON')
  if (parsed === undefined) return undefined
  const sensitive = Object.keys(parsed).find(key => /KEY|PASSWORD|SECRET|TOKEN/iu.test(key))
  if (sensitive !== undefined) {
    throw new Error(`DSH_PHALANX_RUNTIME_ENV_JSON must not contain credential-like key ${JSON.stringify(sensitive)}; keep platform credentials in dsh-phalanx configuration`)
  }
  return parsed
}

function parseJson(value: string, name: string): unknown {
  try {
    return JSON.parse(value) as unknown
  } catch {
    throw new Error(`${name} must contain valid JSON`)
  }
}

function parsePort(value: string): number {
  if (!/^\d+$/u.test(value)) throw new Error('DSH_PHALANX_PORT must be an integer between 0 and 65535')
  const port = Number(value)
  if (port < 0 || port > 65_535) throw new Error('DSH_PHALANX_PORT must be an integer between 0 and 65535')
  return port
}

function parseInstancePort(value: string, name: string): number {
  if (!/^\d+$/u.test(value)) throw new Error(`${name} must be an integer between 1 and 65535`)
  const port = Number(value)
  if (port < 1 || port > 65_535) throw new Error(`${name} must be an integer between 1 and 65535`)
  return port
}

function parseIdleReclaimSeconds(value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  if (!/^\d+$/u.test(value)) throw new Error('DSH_PHALANX_IDLE_RECLAIM_SECONDS must be a non-negative integer')
  const seconds = Number(value)
  if (!Number.isSafeInteger(seconds)) throw new Error('DSH_PHALANX_IDLE_RECLAIM_SECONDS must be a non-negative integer')
  return seconds
}

function parseRegistration(value: string | undefined): false {
  if (value === undefined || value.trim() === '' || value === 'false') return false
  if (value === 'true') throw new Error('DSH_PHALANX_REGISTRATION_ENABLED: open registration is unavailable in 0.1.0')
  throw new Error('DSH_PHALANX_REGISTRATION_ENABLED must be false; open registration is unavailable in 0.1.0')
}

function required(environment: Environment, name: string): string {
  const value = optional(environment, name)
  if (value === undefined) throw new Error(`${name} is required`)
  return value
}

function optional(environment: Environment, name: string): string | undefined {
  const value = environment[name]
  if (value === undefined || value.trim() === '') return undefined
  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
