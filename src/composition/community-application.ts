import { FileCommunityMaintenance } from '../adapters/community-maintenance.js'
import { secureCommunityProxyCookies } from '../inbound/community-proxy-cookies.js'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createProxyServer } from 'http-proxy-3'
import type { IncomingMessage } from 'node:http'
import { validateCommunityModelCredential, validateCommunityNetworkAddresses, type CommunityConfig } from '../domain/community-config.js'
import { validateConfig } from '../domain/config-validation.js'
import type { CommunityRuntimePort } from '../ports/community-runtime.js'
import type { CommunityApplication } from '../ports/community-application.js'
import { FileCommunityModelAccess } from '../adapters/community-model-access.js'
import { SharedCommunityModelUpstream } from '../adapters/community-model-upstream.js'
import { CommunityModelAuthorization } from '../use-cases/community-model-authorization.js'
import { createCommunityModelGateway } from '../inbound/community-model-gateway.js'
import { CommunityAccountStore } from '../adapters/community-account-store.js'
import { CommunityBootstrapCredential, assertCommunityDataRoot } from '../adapters/community-bootstrap.js'
import { PlatformLock } from '../adapters/platform-lock.js'
import { FileCommunityUserSpaces } from '../adapters/community-user-spaces.js'
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
import { FileSharedModelStore, initialSharedModelState } from '../adapters/shared-model-store.js'
import { SharedModelAdministration } from '../use-cases/shared-model-administration.js'
import { CommunityInstanceActions } from '../use-cases/community-instance-actions.js'
import { createCommunityMemberRoute } from '../inbound/community-member-route.js'

import { FileCommunityEnvironmentUpgrade } from '../adapters/community-environment-upgrade.js'
import { CommunityEnvironmentUpgrade } from '../use-cases/community-environment-upgrade.js'
import { FileCommunityEnvironment } from '../adapters/community-environment.js'
import { CommunityEnvironmentRecovery } from '../use-cases/community-environment-recovery.js'
import type { CommunityEnvironmentPort } from '../ports/community-environment.js'

export interface CommunityApplicationOptions {
  readonly runtime?: CommunityRuntimePort
  readonly environment?: CommunityEnvironmentPort
}

/** Wires the community product entry, accounts, private instances and model defaults. */
export function createCommunityApplication(config: CommunityConfig, options: CommunityApplicationOptions = {}): CommunityApplication {
  validateConfig(config)
  validateCommunityModelCredential(config)
  validateCommunityNetworkAddresses(config)
  const maintenance = new FileCommunityMaintenance(config.maintenanceFile)
  const sessions = new PlatformSessionCodec(config.sessionSecret)
  assertCommunityDataRoot(config.runtime.dataRoot)
  const lock = new PlatformLock(config.runtime.dataRoot)
  let accounts: CommunityAccountStore
  try { accounts = new CommunityAccountStore(join(config.runtime.dataRoot, 'community-accounts.db')) }
  catch (error) { lock.close(); throw error }
  let userSpaces: FileCommunityUserSpaces
  let modelAccess: FileCommunityModelAccess
  let modelStore: FileSharedModelStore
  try {
    modelStore = new FileSharedModelStore(join(config.runtime.dataRoot, 'shared-models.json'), initialSharedModelState(config), config.runtime)
    modelAccess = new FileCommunityModelAccess(join(config.runtime.dataRoot, 'model-access.json'))
    userSpaces = new FileCommunityUserSpaces(config.runtime, accounts)
  }
  catch (error) { accounts.close(); lock.close(); throw error }
  const credential = new CommunityBootstrapCredential(config.runtime.dataRoot, accounts.bootstrapComplete.bind(accounts))
  const environmentStorage = options.environment ?? new FileCommunityEnvironment(config.runtime.dataRoot, userSpaces)
  const upgrade = new CommunityEnvironmentUpgrade(new FileCommunityEnvironmentUpgrade(config.runtime.dataRoot, userSpaces), environmentStorage)
  const runtime = options.runtime ?? new CommunityInstanceLifecycle(new CommunityRuntimeDriver(config.runtime, userSpaces, upgrade),
    userId => ({ url: `${lifecycle.gatewayOrigin().origin}${MODEL_GATEWAY_BASE_PATH}`, token: modelAccess.forUser(userId, accounts.getState(userId)!.spaceId) }))
  const dshSession = new HttpDshSession()
  const onboarding = new CommunityOnboarding(accounts, credential)
  const entry = new CommunityEntry(accounts, runtime, dshSession, userSpaces)
  const connections = new MemorySessionRegistry()
  const administration = new CommunityAccountAdministration(accounts, runtime, connections)
  const actions = new CommunityInstanceActions(accounts, runtime, connections)
  const environment = new CommunityEnvironmentRecovery(accounts, runtime, environmentStorage, connections)
  const modelAdministration = new SharedModelAdministration(accounts, modelStore)
  const modelAuthorization = new CommunityModelAuthorization(accounts, modelAccess)
  const model = createCommunityModelGateway({ authorization: modelAuthorization, connections,
    upstream: new SharedCommunityModelUpstream(modelStore) })
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
  proxy.on('proxyRes', secureCommunityProxyCookies(origin))
  const routes = communityAccountRoutes({ onboarding, entry, sessions, origin })
  const recovery = createCommunityMemberRoute({ entry, actions })
  const admin = createCommunityAdminRoute({ authenticate, onboarding, administration, runtime, assets, origin,
    models: modelAdministration, environment })
  const runtimeMount = entry.spacePath.bind(entry)
  const ensureRuntime = entry.ensure.bind(entry)
  const dispatch = createHttpEntry({ maintenance, origin, recordsReady: () => lifecycle.recordsReady(), connections,
    model, processGateways: config.runtime.container === undefined, bootstrap: routes.bootstrap, admin, enter: routes.enter,
    loginForm: routes.loginForm, login: routes.login, recovery,
    session, runtimeMount, ensureRuntime, rememberRuntimeCookie: rememberCookie, proxy })
  const idle = createIdleReclamation({ idleSeconds: config.idleReclaimSeconds, clock: systemClock, sessions: connections, runtime, dsh: dshSession,
    users: () => [...onboarding.activeUsernames()], recordsReady: () => lifecycle.recordsReady(), gateClosed: entry.accessClosed.bind(entry),
    origin, onReclaimed: connections.clearIdle.bind(connections), onError: () => { console.warn('Idle user-space check failed; retained the instance') } })
  const lifecycle: CommunityLifecycle = new CommunityLifecycle({ config, knownUsers: onboarding.activeUsernames.bind(onboarding), runtime, connections,
    prepareBootstrap: credential.prepare.bind(credential), checkIdle: idle.check, closeResources: () => { proxy.close(); accounts.close(); lock.close() },
    createGatewayListener: () => createGatewayOnlyServer({ maintenance, connections, model, network }),
    createListener: () => createPublicServer({ connections,
      handle: protectCommunityEntry(dispatch, origin),
      upgrade: { maintenance, origin, recordsReady: lifecycle.recordsReady.bind(lifecycle),
        session, runtimeMount, ensureRuntime, rememberCookie, connections, proxy },
    }),
  })
  return lifecycle
}
