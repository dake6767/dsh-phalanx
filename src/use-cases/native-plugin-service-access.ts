import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { combineAcquisitionSources } from '../domain/acquisition-sources.js'
import { PluginUpstreamAccessError, type PluginUpstream } from '../domain/plugin-upstream.js'
import type { CommunityAccountActor, CommunityAccountRecord } from '../domain/community-account.js'
import type { CatalogPluginServiceSlot } from '../domain/suite-service-slots.js'
import type { CommunityAccountReaderPort, CommunityAccountRegistration } from '../ports/community-accounts.js'
import type { CommunityRuntimePort, CommunityUserInstance } from '../ports/community-runtime.js'
import type { PluginGroupConfigurationPort } from '../ports/managed-plugins.js'
import type { PlatformSigningKeyPort } from '../ports/platform-signing-key.js'
import type { PluginAccessStorePort } from '../ports/plugin-access.js'
import type { PluginInstallationsPort } from '../ports/plugin-installations.js'
import type { PluginLibraryStorePort } from '../ports/plugin-library.js'
import type { MemberPluginManagerPort } from '../ports/plugin-market.js'

export const NATIVE_PLUGIN_SERVICE_PATH = '/_dsh-phalanx/plugin-services/'
type ServiceSelection = { username: string; packageName: string; slot: string; backend: string }
export type NativePluginServiceScope = ServiceSelection & { binding: string }
export type NativePluginServiceProtocol = CatalogPluginServiceSlot['backends'][number]['protocol']
interface ServiceGrant {
  readonly binding: string
  readonly username: string
  readonly groupId: string
  readonly protocol: NativePluginServiceProtocol
  readonly model: string
  readonly upstream: PluginUpstream
}

const denied = () => new PluginUpstreamAccessError(403, 'Platform service is no longer available to this plugin. Choose a service in the plugin settings.')
const invalidToken = () => new PluginUpstreamAccessError(401, 'A valid plugin service token is required')
const unavailable = () => new PluginUpstreamAccessError(503, 'This platform service is disabled or incomplete. Choose a service in the plugin settings.')

/** Native credentials never authorize a legacy plugin upstream or a different member, carrier or backend. */
export class NativePluginServiceAccess {
  constructor(
    private readonly deps: {
      accounts: Pick<CommunityAccountReaderPort, 'get' | 'withCurrentState'>
      library: Pick<PluginLibraryStorePort, 'list'>
      grants: Pick<PluginGroupConfigurationPort, 'preinstalls'>
      installations: Pick<PluginInstallationsPort, 'get'>
      services: Required<Pick<PluginAccessStorePort, 'installedServices' | 'installedServiceOwner'>>
      runtime: Pick<CommunityRuntimePort, 'status'>
      manager: Pick<MemberPluginManagerPort, 'list'> & Required<Pick<MemberPluginManagerPort, 'verifyArchive'>>
      origin: () => URL
      gatewayOrigin: () => URL
      signingKey: PlatformSigningKeyPort
      revision: () => string
      runtimeRevision: string
    },
  ) {}

  /** A successful new delivery may claim this exact catalog origin. Old delivery rows have no claim. */
  async describeDelivery(packageName: string) {
    const plugin = (await this.deps.library.list()).find(row => row.packageName === packageName)
    if (
      !plugin?.suiteOrigin ||
      plugin.removing ||
      plugin.incompatible ||
      plugin.stage !== 'available' ||
      plugin.current?.runtimeRevision !== this.deps.runtimeRevision
    )
      return undefined
    const serviceOrigin = (await this.deps.services.installedServiceOwner(packageName)) === plugin.current.integrity ? plugin.suiteOrigin : undefined
    const resourceOrigin = plugin.suiteResourceBindings?.length ? plugin.suiteOrigin : undefined
    if (!serviceOrigin && !resourceOrigin) return undefined
    return {
      version: plugin.current.version,
      integrity: plugin.current.integrity,
      ...(serviceOrigin ? { serviceOrigin } : {}),
      ...(resourceOrigin ? { resourceOrigin } : {}),
    }
  }

  async issue(actor: CommunityAccountActor, instance: CommunityUserInstance, packageName: string, slot: string, backend: string, signal: AbortSignal) {
    const selection = { username: actor.username, packageName, slot, backend }
    const revision = this.deps.revision()
    const account = await this.deps.accounts.get(actor.username)
    if (!account || account.spaceId !== actor.spaceId || account.sessionEpoch !== actor.sessionEpoch || this.currentInstance(account) !== instance)
      throw denied()
    const { binding, model, protocol } = await this.resolve(selection, account, instance, signal)
    await this.commit(account, instance, revision, signal, () => undefined)
    const token = this.token(account, instance, { ...selection, binding })
    const origin = this.deps.gatewayOrigin()
    if (origin.protocol !== 'http:' || origin.hostname !== '127.0.0.1') throw unavailable()
    const path = [actor.username, packageName, slot, backend, binding].map(encodeURIComponent).join('/')
    return { token, url: origin.origin + NATIVE_PLUGIN_SERVICE_PATH + path, model, protocol }
  }

  async authenticate(scope: NativePluginServiceScope, token: string) {
    if (!/^[A-Za-z0-9_-]{43}$/u.test(token)) throw invalidToken()
    const account = await this.deps.accounts.get(scope.username)
    if (!account) throw invalidToken()
    const instance = this.currentInstance(account)
    if (!instance || !timingSafeEqual(Buffer.from(token), Buffer.from(this.token(account, instance, scope)))) throw invalidToken()
    return { account, instance }
  }

  async register<T>(
    scope: NativePluginServiceScope,
    token: string,
    signal: AbortSignal,
    register: (grant: ServiceGrant, onAbort: (cleanup: () => void) => void) => ReturnType<CommunityAccountRegistration<T>>,
  ): Promise<T> {
    const revision = this.deps.revision()
    const { account, instance } = await this.authenticate(scope, token)
    const grant = await this.resolve(scope, account, instance, signal)
    if (grant.binding !== scope.binding) throw denied()
    return await this.commit(account, instance, revision, signal, (_current, onAbort) => register(grant, onAbort))
  }

  private async commit<T>(
    account: CommunityAccountRecord,
    instance: CommunityUserInstance,
    revision: string,
    signal: AbortSignal,
    register: CommunityAccountRegistration<T>,
  ): Promise<T> {
    const cleanup: (() => void)[] = []
    try {
      const result = await this.deps.accounts.withCurrentState<T>(account.username, (current, onAbort) => {
        signal.throwIfAborted()
        if (
          !current ||
          current.groupId !== account.groupId ||
          current.sessionEpoch !== account.sessionEpoch ||
          this.currentInstance(current) !== instance ||
          this.deps.revision() !== revision
        )
          throw denied()
        return register(current, undo => {
          let active = true
          const once = () => {
            if (active) {
              active = false
              undo()
            }
          }
          cleanup.push(once)
          onAbort(once)
        })
      })
      if (this.deps.revision() !== revision || this.currentInstance(account) !== instance) throw denied()
      return result
    } catch (error) {
      for (const undo of cleanup.reverse()) undo()
      throw error
    }
  }

  private currentInstance(account: CommunityAccountRecord) {
    if (account.disabled) return undefined
    const state = this.deps.runtime.status(account.username)
    if (state.state !== 'ready' && state.state !== 'draining') return undefined
    const { instance } = state
    return instance.resourceKey && instance.userId === account.username && instance.spaceId === account.spaceId ? instance : undefined
  }

  private token(account: CommunityAccountRecord, instance: CommunityUserInstance, scope: NativePluginServiceScope) {
    return createHmac('sha256', this.deps.signingKey.read())
      .update('native-plugin-service\0')
      .update(
        JSON.stringify([
          account.username,
          account.spaceId,
          account.sessionEpoch,
          instance.resourceKey,
          scope.packageName,
          scope.slot,
          scope.backend,
          scope.binding,
        ]),
      )
      .digest('base64url')
  }

  async bindingAvailability(actor: CommunityAccountActor, instance: CommunityUserInstance, packageName: string) {
    const account = await this.deps.accounts.get(actor.username)
    if (!account || account.spaceId !== actor.spaceId || account.sessionEpoch !== actor.sessionEpoch || this.currentInstance(account) !== instance)
      return undefined
    try {
      const { services } = await this.qualifiedDelivery(packageName, account, instance)
      return {
        revision: services.revision,
        enabled: services.configuration.slots
          .filter(slot =>
            slot.backends.some(backend => {
              const setting = services.configuration.settings.find(row => row.slot === slot.id && row.backend === backend.id)
              return setting?.enabled && backend.fields.every(field => !field.required || Boolean(setting.values[field.name]))
            }),
          )
          .map(slot => slot.id),
      }
    } catch (error) {
      if (error instanceof PluginUpstreamAccessError) return undefined
      throw error
    }
  }

  private async qualifiedDelivery(packageName: string, account: CommunityAccountRecord, instance: CommunityUserInstance) {
    const plugin = (await this.deps.library.list()).find(row => row.packageName === packageName)
    const prepared = plugin?.current
    if (
      !plugin?.suiteOrigin ||
      plugin.removing ||
      plugin.incompatible ||
      plugin.stage !== 'available' ||
      prepared?.runtimeRevision !== this.deps.runtimeRevision ||
      instance.managedSnapshot?.some(row => row.startsWith(`${packageName}@`))
    )
      throw denied()
    const [records, preinstalls, services] = await Promise.all([
      this.deps.installations.get(account.spaceId),
      this.deps.grants.preinstalls(account.groupId),
      this.deps.services.installedServices(packageName),
    ])
    const delivered = records.find(
      row =>
        row.packageName === packageName && row.version === prepared.version && row.integrity === prepared.integrity && row.serviceOrigin === plugin.suiteOrigin,
    )
    const qualified = combineAcquisitionSources([
      { source: 'managed', names: preinstalls },
      { source: 'selected', names: plugin.published && delivered?.source === 'selected' ? [packageName] : [] },
    ])
    if (!delivered || !qualified.has(packageName) || services?.configuration.ownerVersion !== prepared.integrity) throw denied()
    return { plugin, prepared, services }
  }

  private async resolve(scope: ServiceSelection, account: CommunityAccountRecord, instance: CommunityUserInstance, signal: AbortSignal): Promise<ServiceGrant> {
    const { packageName } = scope
    const { plugin, prepared, services } = await this.qualifiedDelivery(packageName, account, instance)
    const backend = services.configuration.slots.find(row => row.id === scope.slot)?.backends.find(row => row.id === scope.backend)
    const settings = services.configuration.settings.find(row => row.slot === scope.slot && row.backend === scope.backend)
    if (!backend || !settings?.enabled || backend.fields.some(field => field.required && !settings.values[field.name])) throw unavailable()
    const { endpoint, key, model } = backend.upstream
    const base = new URL(settings.values[endpoint]!)
    const credential = settings.values[key]!
    if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.hash || base.search || /[^\x21-\x7e]/u.test(credential))
      throw unavailable()
    const checkSignal = AbortSignal.any([signal, AbortSignal.timeout(15_000)])
    const actual = (await this.deps.manager.list(instance, this.deps.origin(), checkSignal)).find(row => row.packageName === packageName)
    if (
      actual?.enabled !== true ||
      actual.version !== prepared.version ||
      actual.archiveIntegrity !== prepared.integrity ||
      !(await this.deps.manager.verifyArchive(instance, packageName, prepared.integrity, checkSignal))
    )
      throw denied()
    return {
      binding: createHash('sha256')
        .update(JSON.stringify([plugin.suiteOrigin, prepared.integrity, services.configuration.identity]))
        .digest('base64url'),
      username: account.username,
      groupId: account.groupId,
      model: settings.values[model]!,
      protocol: backend.protocol,
      upstream: { name: scope.backend, baseUrl: base.href, credential, headers: [{ name: 'authorization', value: 'Bearer {credential}' }] },
    }
  }
}
