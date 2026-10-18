import type { DownloadSourceSelection } from './download-source.js'
import { isPublicIPv4 } from './public-address.js'

/** Rootless container launcher and its private model/network listener. */
export interface ContainerConfig {
  readonly runtime: string
  readonly image: string
  readonly internalPort: number
  readonly gatewayPort: number
  /** Positive resource limits only (--memory, --cpus, --pids-limit). */
  readonly extraArgs?: readonly string[]
}

/** DSH launch inputs. Model rows are defaults in the user's writable native profile. */
export interface CommunityRuntimeConfig {
  readonly command: string
  readonly args: readonly string[]
  readonly dataRoot: string
  /** Existing deployer-owned root for all private homes and workspaces. */
  readonly userDataRoot?: string
  /** Expected Linux mount point containing external user data. */
  readonly userDataMount?: string
  readonly environment?: Readonly<Record<string, string>>
  readonly patches?: readonly string[]
  readonly startupTimeoutMs?: number
  readonly shutdownTimeoutMs?: number
  readonly container?: ContainerConfig
  readonly defaultModel: {
    readonly provider: string
    readonly model: string
    readonly upstream: { readonly baseUrl: string }
  }
}

export interface CommunityConfig {
  readonly downloadSources?: DownloadSourceSelection
  /** Online suite-catalog service; the default address goes through the download source's GitHub prefix. */
  readonly suiteCatalog?: { readonly address: string }
  readonly listen: { readonly host: string, readonly port: number, readonly publicOrigin?: string }
  /** Reserved registration setting. Open registration is unavailable in 0.1.0. */
  readonly registration?: { readonly enabled: false }
  /** Separate same-host origin for untrusted container applications. */
  readonly preview?: { readonly port: number; readonly publicOrigin: string }
  readonly sessionSecret: string
  readonly runtime: CommunityRuntimeConfig
  readonly maintenanceFile?: string
  readonly adminUiRoot?: string
  /** Seconds without an entry connection or active agent; zero disables reclamation. */
  readonly idleReclaimSeconds?: number
  /** Deployer-only credential, never a child launch input. */
  readonly modelGateway?: { readonly upstreamApiKey: string }
  /** Complete public IPv4 host aliases, including cloud NAT addresses absent from interfaces. */
  readonly network?: { readonly hostPublicAddresses: readonly string[] }
}

/** Validates a deployer-provided catalog address: HTTP(S), no credentials, query or fragment. */
export function suiteCatalogAddress(input: unknown): string {
  const fail = (): never => { throw new Error('The suite catalog address must be an HTTP(S) URL without credentials, a query or a fragment.') }
  if (typeof input !== 'string' || input === '' || input.length > 2048 || input.includes('\\') || /\s/u.test(input)
    || [...input].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) return fail()
  let url: URL
  try { url = new URL(input) } catch { return fail() }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || Number(url.port) === 0) return fail()
  return url.href
}

export function validateCommunityNetworkAddresses(config: Pick<CommunityConfig, 'network'>): void {
  if (config.network?.hostPublicAddresses.some(address => !isPublicIPv4(address))) {
    throw new Error('Host public addresses must be public IPv4 literals')
  }
}

/** Validate platform credential syntax without exposing its value in diagnostics. */
export function validateCommunityModelCredential(config: Pick<CommunityConfig, 'modelGateway'>): void {
  const key = config.modelGateway?.upstreamApiKey
  if (key !== undefined && (key.trim() === '' || /[^\x20-\x7e]/u.test(key))) {
    throw new Error('Default model upstream credential must be a nonempty HTTP header value')
  }
}
