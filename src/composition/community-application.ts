import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createProxyServer } from 'http-proxy-3'
import type { IncomingMessage } from 'node:http'
import { validateCommunityModelCredential, validateCommunityNetworkAddresses, type CommunityConfig } from '../domain/community-config.js'
import { validateConfig } from '../domain/config-validation.js'
import type { CommunityRuntimePort } from '../ports/community-runtime.js'
import type { CommunityApplication } from '../ports/community-application.js'
import { FileCommunityModelAccess } from '../adapters/community-model-access.js'
import { StaticCommunityModelUpstream } from '../adapters/community-model-upstream.js'
import { CommunityModelAuthorization } from '../use-cases/community-model-authorization.js'
import { createCommunityModelGateway } from '../inbound/community-model-gateway.js'
import { CommunityAccountStore } from '../adapters/community-account-store.js'
import { CommunityBootstrapCredential, assertCommunityDataRoot } from '../adapters/community-bootstrap.js'
import { PlatformLock } from '../adapters/platform-lock.js'
import { CommunityRuntimeDriver } from '../adapters/community-runtime-driver.js'
import { CommunityInstanceLifecycle } from '../use-cases/community-instance-lifecycle.js'
import { HttpDshSession } from '../adapters/dsh-session.js'
import { MemorySessionRegistry } from '../adapters/memory-session-registry.js'
import { FileAdminAssetSource } from '../adapters/file-admin-assets.js'
import { AdminAssetServer } from '../inbound/admin-assets.js'
import { CommunityOnboarding } from '../use-cases/community-onboarding.js'
import { CommunityEntry } from '../use-cases/community-entry.js'
import { CommunityAccountAdministration } from '../use-cases/community-account-administration.js'
import { createCommunityAdminRoute } from '../inbound/community-admin-route.js'
import { communityAccountRoutes } from '../inbound/community-account-routes.js'
import { createHttpEntry } from '../inbound/http-entry.js'
import { handleProxyError } from '../inbound/proxy-error.js'
import { createGatewayOnlyServer, createPublicServer } from '../inbound/public-server.js'
import { protectCommunityEntry } from '../inbound/community-http-entry.js'
import { PlatformSessionCodec, authenticatedUser, rememberRuntimeCookie } from '../inbound/platform-session.js'
import { MODEL_GATEWAY_BASE_PATH } from '../dsh/model-protocol.js'
import { systemClock } from '../adapters/system-clock.js'
import { createIdleReclamation } from '../use-cases/idle-reclamation.js'
import { CommunityLifecycle } from './community-lifecycle.js'
import { CommunityNetworkAccess } from '../use-cases/community-network-access.js'
import { NodeNetworkResolver, NodeNetworkTransport } from '../adapters/public-network.js'
import { createCommunityNetworkProxy } from '../inbound/community-network-proxy.js'

export interface CommunityApplicationOptions {
  readonly runtime?: CommunityRuntimePort
}

/** Wires the community product entry, accounts, private instances and model defaults. */
export function createCommunityApplication(config: CommunityConfig, options: CommunityApplicationOptions = {}): CommunityApplication {
  validateConfig(config)
  validateCommunityModelCredential(config)
  validateCommunityNetworkAddresses(config)
  const sessions = new PlatformSessionCodec(config.sessionSecret)
  assertCommunityDataRoot(config.runtime.dataRoot)
  const lock = new PlatformLock(config.runtime.dataRoot)
  let accounts: CommunityAccountStore
  try { accounts = new CommunityAccountStore(join(config.runtime.dataRoot, 'community-accounts.db')) }
  catch (error) { lock.close(); throw error }
  let modelAccess: FileCommunityModelAccess
  try { modelAccess = new FileCommunityModelAccess(join(config.runtime.dataRoot, 'model-access.json')) }
  catch (error) { accounts.close(); lock.close(); throw error }
  const credential = new CommunityBootstrapCredential(config.runtime.dataRoot, accounts.bootstrapComplete.bind(accounts))
  const runtime = options.runtime ?? new CommunityInstanceLifecycle(new CommunityRuntimeDriver(config.runtime),
    (userId, authority) => ({ url: `http://${config.runtime.container === undefined ? authority : `127.0.0.1:${config.runtime.container.gatewayPort}`}${MODEL_GATEWAY_BASE_PATH}`, token: modelAccess.forUser(userId) }))
  const dshSession = new HttpDshSession()
  const onboarding = new CommunityOnboarding(accounts, credential)
  const entry = new CommunityEntry(accounts, runtime, dshSession)
  const connections = new MemorySessionRegistry()
  const administration = new CommunityAccountAdministration(accounts, runtime, connections)
  const modelAuthorization = new CommunityModelAuthorization(accounts, modelAccess)
  const modelUpstream = config.modelGateway === undefined ? undefined
    : new StaticCommunityModelUpstream(config.runtime.defaultModel.upstream.baseUrl, config.modelGateway.upstreamApiKey)
  const model = createCommunityModelGateway({ authorization: modelAuthorization, connections,
    model: config.runtime.defaultModel.model, ...(modelUpstream === undefined ? {} : { upstream: modelUpstream }) })
  const networkAccess = new CommunityNetworkAccess(modelAuthorization, new NodeNetworkResolver(config.listen.publicOrigin, config.network?.hostPublicAddresses))
  const network = createCommunityNetworkProxy({ access: networkAccess, transport: new NodeNetworkTransport(), connections })
  const proxy = createProxyServer({ ws: true })
  proxy.on('error', handleProxyError)
  const authenticate = (request: IncomingMessage) => authenticatedUser(request, sessions, accounts.getState.bind(accounts))
  const session = { authenticate,
    current: (request: IncomingMessage, username: string) => authenticate(request) === username }
  const rememberCookie = (username: string, header: string | undefined) => rememberRuntimeCookie(connections, username, header)
  const assets = new AdminAssetServer(new FileAdminAssetSource(config.adminUiRoot
    ?? fileURLToPath(new URL('../../admin-ui/dist', import.meta.url)), 'community.html'))
  const origin = () => lifecycle.origin()
  const routes = communityAccountRoutes({ onboarding, entry, sessions, origin })
  const admin = createCommunityAdminRoute({ authenticate, onboarding, administration, runtime, assets, origin })
  const ensureRuntime = entry.ensure.bind(entry)
  const dispatch = createHttpEntry({ origin, recordsReady: () => lifecycle.recordsReady(), connections,
    model, processGateways: config.runtime.container === undefined, bootstrap: routes.bootstrap, admin,
    loginForm: routes.loginForm, login: routes.login,
    session, ensureRuntime, rememberRuntimeCookie: rememberCookie, proxy })
  const idle = createIdleReclamation({ idleSeconds: config.idleReclaimSeconds, clock: systemClock, sessions: connections, runtime, dsh: dshSession,
    users: () => [...onboarding.activeUsernames()], recordsReady: () => lifecycle.recordsReady(), gateClosed: entry.accessClosed.bind(entry),
    origin, onReclaimed: connections.clearIdle.bind(connections), onError: () => { console.warn('Idle user-space check failed; retained the instance') } })
  const lifecycle: CommunityLifecycle = new CommunityLifecycle({ config, knownUsers: onboarding.activeUsernames.bind(onboarding), runtime, connections,
    prepareBootstrap: credential.prepare.bind(credential), checkIdle: idle.check, closeResources: () => { proxy.close(); accounts.close(); lock.close() },
    ...(config.runtime.container === undefined ? {} : { createGatewayListener: () => createGatewayOnlyServer({ connections, model, network }) }),
    createListener: () => createPublicServer({ connections,
      handle: protectCommunityEntry(dispatch, origin),
      upgrade: { origin, recordsReady: lifecycle.recordsReady.bind(lifecycle),
        session, ensureRuntime, rememberCookie, connections, proxy },
    }),
  })
  return lifecycle
}
