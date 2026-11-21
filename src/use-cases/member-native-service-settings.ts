import { nativeJsonSettingsHistoryKey } from '../ports/plugin-installations.js'
import { createHash } from 'node:crypto'
import type { CommunityMarketNativeServiceView, CommunityNativeServiceBindingView as BindingView } from '../domain/plugin-admin-contract.js'
import type { CommunityAccountActor } from '../domain/community-account.js'
import { PluginUpstreamAccessError } from '../domain/plugin-upstream.js'
import { canonicalJson } from '../domain/suite-catalog-document.js'
import { usesDeferredPluginUpstream, type CatalogJsonServiceBinding, type CatalogPluginServiceSlot } from '../domain/suite-service-slots.js'
import type { CommunityUserInstance } from '../ports/community-runtime.js'
import type { NativeServiceSettingsTransport } from '../ports/member-native-plugins.js'
import type { PluginAccessStorePort } from '../ports/plugin-access.js'
import type { NativeJsonFieldHistory, PluginInstallation, PluginInstallationsPort, PluginServiceSettingsHistoryPort } from '../ports/plugin-installations.js'
import type { NativePluginServiceAccess } from './native-plugin-service-access.js'

type BindingSnapshot = { readonly revision: string | undefined; readonly bindings: readonly BindingView[] }
type BindingRun = {
  readonly abort: AbortController
  readonly instance: CommunityUserInstance
  readonly beforeEntry: boolean
  work: Promise<readonly BindingView[]>
}
type SlotSync = {
  actor: CommunityAccountActor
  instance: CommunityUserInstance
  origin: URL
  record: PluginInstallation
  slot: CatalogPluginServiceSlot
  backend: CatalogPluginServiceSlot['backends'][number]
  signal: AbortSignal
}
type SlotResult = { record: PluginInstallation; view: Omit<BindingView, 'slot'> }

const digest = (data: unknown) => createHash('sha256').update(canonicalJson(data)).digest('hex')

/** Coordinates carrier RPC and durable ownership facts without reading native settings on the host. */
export class MemberNativeServiceSettings {
  private readonly running = new Map<string, BindingRun>()
  private readonly launch = new WeakMap<CommunityUserInstance, Promise<void>>()
  private readonly views = new WeakMap<CommunityUserInstance, Map<string, BindingSnapshot>>()
  private readonly shutdown = new AbortController()
  constructor(
    private readonly records: Pick<PluginInstallationsPort, 'get'> & PluginServiceSettingsHistoryPort,
    private readonly settings: Required<Pick<PluginAccessStorePort, 'installedServices'>>,
    private readonly access: Pick<NativePluginServiceAccess, 'issue'> & Partial<Pick<NativePluginServiceAccess, 'bindingAvailability'>>,
    private readonly transport: NativeServiceSettingsTransport,
  ) {}

  view(instance: CommunityUserInstance, packageName: string): readonly BindingView[] | undefined {
    return this.views.get(instance)?.get(packageName)?.bindings
  }

  async list(actor: CommunityAccountActor, instance: CommunityUserInstance): Promise<readonly CommunityMarketNativeServiceView[]> {
    return await Promise.all(
      [...(this.views.get(instance) ?? [])]
        .filter(([, view]) => view.bindings.length)
        .map(async ([packageName, view]) => {
          if (!this.access.bindingAvailability) return { packageName, bindings: view.bindings }
          const current = await this.access.bindingAvailability(actor, instance, packageName)
          const bindings = view.bindings.map(binding => {
            if (binding.status === 'unsupported' || binding.status === 'personal') return binding
            if (!current?.enabled.includes(binding.slot)) return { slot: binding.slot, status: 'inactive' as const }
            if (current.revision !== view.revision)
              return { slot: binding.slot, status: 'pending' as const, ...(binding.nextStart ? { nextStart: true as const } : {}) }
            return binding
          })
          return { packageName, bindings }
        }),
    )
  }

  ensureLaunch(actor: CommunityAccountActor, instance: CommunityUserInstance, origin: URL): Promise<void> {
    const previous = this.launch.get(instance)
    if (previous) return previous
    const work = this.applyLaunch(actor, instance, origin).catch(() => {})
    this.launch.set(instance, work)
    return work
  }

  private async applyLaunch(actor: CommunityAccountActor, instance: CommunityUserInstance, origin: URL): Promise<void> {
    for (const record of await this.records.get(actor.spaceId)) {
      if (this.shutdown.signal.aborted) return
      if (
        record.serviceOrigin &&
        (!this.view(instance, record.packageName) || this.view(instance, record.packageName)?.some(binding => binding.status === 'pending'))
      )
        await this.apply(actor, instance, record.packageName, origin, true)
    }
  }

  apply(actor: CommunityAccountActor, instance: CommunityUserInstance, packageName: string, origin: URL, beforeEntry = false): Promise<readonly BindingView[]> {
    if (this.shutdown.signal.aborted || instance.spaceId !== actor.spaceId || instance.userId !== actor.username) return Promise.resolve([])
    const key = actor.spaceId + '\0' + packageName
    const existing = this.running.get(key)
    if (existing?.instance === instance)
      return beforeEntry && !existing.beforeEntry
        ? existing.work.catch(() => []).then(() => this.apply(actor, instance, packageName, origin, true))
        : existing.work
    if (existing) {
      existing.abort.abort()
      return existing.work.catch(() => []).then(() => this.apply(actor, instance, packageName, origin, beforeEntry))
    }
    const abort = new AbortController()
    const signal = AbortSignal.any([this.shutdown.signal, abort.signal, AbortSignal.timeout(60_000)])
    const work = this.sync(actor, instance, packageName, origin, signal, beforeEntry)
      .then(({ revision, bindings }) => {
        let views = this.views.get(instance)
        if (!views) this.views.set(instance, (views = new Map()))
        views.set(packageName, { revision, bindings })
        return bindings
      })
      .finally(() => this.running.delete(key))
    this.running.set(key, { abort, instance, beforeEntry, work })
    return work
  }

  async refreshUpstream(actor: CommunityAccountActor, instance: CommunityUserInstance, packageName: string, origin: URL): Promise<void> {
    if (!(await this.records.get(actor.spaceId)).some(record => record.packageName === packageName && record.serviceOrigin)) return
    await this.running.get(actor.spaceId + '\0' + packageName)?.work.catch(() => [])
    await this.apply(actor, instance, packageName, origin)
  }

  async cancelSpace(spaceId: string) {
    const runs = [...this.running].filter(([key]) => key.startsWith(spaceId + '\0')).map(([, run]) => run)
    for (const run of runs) run.abort.abort()
    await Promise.allSettled(runs.map(run => run.work))
  }

  async stop() {
    this.shutdown.abort()
    await Promise.allSettled([...this.running.values()].map(run => run.work))
  }

  private async sync(
    actor: CommunityAccountActor,
    instance: CommunityUserInstance,
    packageName: string,
    origin: URL,
    signal: AbortSignal,
    beforeEntry: boolean,
  ): Promise<BindingSnapshot> {
    const [deliveries, installed] = await Promise.all([this.records.get(actor.spaceId), this.settings.installedServices(packageName)])
    let record = deliveries.find(row => row.packageName === packageName)
    const revision = installed?.revision
    if (!record?.serviceOrigin || !record.integrity) return { revision, bindings: [] }
    if (!installed || installed.configuration.ownerVersion !== record.integrity) return { revision, bindings: [{ slot: '', status: 'unsupported' }] }
    const views: BindingView[] = []
    for (const slot of installed.configuration.slots) {
      if (signal.aborted) break
      const configured = installed.configuration.settings.find(row => row.slot === slot.id && row.enabled)
      const deferred = usesDeferredPluginUpstream(slot)
      const nextStart = slot.binding.kind === 'json-settings' && !deferred
      const backend = deferred ? slot.backends[0] : slot.backends.find(row => row.id === configured?.backend)
      if (!backend) {
        views.push({ slot: slot.id, status: 'inactive' })
        continue
      }
      try {
        const input: SlotSync = { actor, instance, origin, record, slot, backend, signal }
        const result: SlotResult =
          slot.binding.kind === 'json-settings'
            ? beforeEntry || deferred
              ? await this.syncJsonSlot(input, slot.binding)
              : { record, view: { status: 'pending' as const } }
            : await this.syncSlot(input)
        views.push({ slot: slot.id, ...result.view, ...(nextStart ? { nextStart: true } : {}) })
        record = result.record
      } catch (error) {
        views.push({
          slot: slot.id,
          status: error instanceof PluginUpstreamAccessError && [403, 503].includes(error.status) ? 'inactive' : 'failed',
          ...(nextStart ? { nextStart: true } : {}),
        })
        record = (await this.records.get(actor.spaceId)).find(row => row.packageName === packageName)
        if (!record?.serviceOrigin || record.integrity !== installed.configuration.ownerVersion) break
      }
    }
    return { revision, bindings: views }
  }

  private async syncJsonSlot(input: SlotSync, binding: CatalogJsonServiceBinding): Promise<SlotResult> {
    const { actor, instance, origin, record, slot, backend, signal } = input
    const syncSettings = this.transport.syncJsonSettings?.bind(this.transport)
    if (!syncSettings) return { record, view: { status: 'unsupported' } }
    const contract = digest(binding.kind)
    const history = record.serviceSettings?.[nativeJsonSettingsHistoryKey]
    if (history && history.contract !== contract) return { record, view: { status: 'unsupported' } }
    const previous = history?.jsonFiles?.[binding.file] ?? {}
    const issue = () => this.access.issue(actor, instance, record.packageName, slot.id, backend.id, signal)
    const grant = await issue()
    const current = async () => {
      const latest = await issue()
      return latest.url === grant.url && latest.token === grant.token && latest.model === grant.model && latest.protocol === grant.protocol
    }
    const fields = Object.fromEntries(
      binding.fields.map(field => [
        field.path.join('.'),
        field.source === 'literal' ? field.value : field.source === 'gateway-url' ? grant.url : field.source === 'model' ? grant.model : grant.token,
      ]),
    )
    const intent = { packageName: record.packageName, integrity: record.integrity!, version: record.version, binding, fields, previous }
    let updated = record
    const save = async (json: NativeJsonFieldHistory) => {
      const next = {
        ...updated.serviceSettings,
        [nativeJsonSettingsHistoryKey]: { contract, applied: null, jsonFiles: { ...history?.jsonFiles, [binding.file]: { ...previous, ...json } } },
      }
      if (digest(updated.serviceSettings?.[nativeJsonSettingsHistoryKey] ?? null) === digest(next[nativeJsonSettingsHistoryKey])) return
      if (!(await this.records.replaceServiceSettings(actor.spaceId, updated, next))) throw Error('Native delivery changed')
      updated = { ...updated, serviceSettings: next }
    }
    const view = (json: NativeJsonFieldHistory): Omit<BindingView, 'slot'> => ({
      status: Object.values(json).some(value => 'detached' in value) ? 'personal' : 'applied',
    })
    const preview = await syncSettings(instance, origin, { ...intent, phase: 'preview' }, signal)
    if (preview.status === 'applied') {
      await save(preview.fields)
      return { record: updated, view: view(preview.fields) }
    }
    if (preview.status !== 'prepared') return { record, view: { status: preview.status } }
    await save(preview.fields)
    if (!(await current())) return { record: updated, view: { status: 'pending' } }
    const result = await syncSettings(instance, origin, { ...intent, phase: 'apply', revision: preview.revision }, signal)
    if (result.status !== 'applied') return { record: updated, view: { status: result.status === 'prepared' ? 'failed' : result.status } }
    await save(result.fields)
    return { record: updated, view: (await current()) ? view(result.fields) : { status: 'pending' } }
  }

  private async syncSlot(input: SlotSync): Promise<SlotResult> {
    const { actor, instance, origin, slot, backend, signal } = input
    let record = input.record
    const { binding, id: slotId } = slot
    if (binding.kind !== 'revisioned-rpc') return { record, view: { status: 'unsupported' } }
    const keys = [...new Set([...Object.values(binding.fields), ...slot.backends.flatMap(row => Object.keys(row.profile ?? {}))])].sort()
    const contract = digest([binding, keys])
    const history = record.serviceSettings?.[slotId]
    if (history && history.contract !== contract) return { record, view: { status: 'unsupported' } }
    const grant = await this.access.issue(actor, instance, record.packageName, slotId, backend.id, signal)
    const { endpoint, key, model, mode, enabled } = binding.fields
    const fields = {
      ...backend.profile,
      [endpoint]: grant.url,
      [key]: grant.token,
      [model]: grant.model,
      [mode]: backend.mode,
      ...(enabled ? { [enabled]: true } : {}),
    }
    const intent = {
      packageName: record.packageName,
      version: record.version,
      integrity: record.integrity!,
      binding,
      id: 'platform-' + digest([record.serviceOrigin, record.packageName, slotId]).slice(0, 24),
      fields,
      keys,
      previous: [history?.applied ?? null, ...(history?.pending ? [history.pending] : [])],
    }
    const save = async (value: NonNullable<PluginInstallation['serviceSettings']>[string]) => {
      const next = { ...record.serviceSettings, [slotId]: value }
      if (!(await this.records.replaceServiceSettings(actor.spaceId, record, next))) throw Error('Native delivery changed')
      record = { ...record, serviceSettings: next }
    }

    const preview = await this.transport.syncSettings(instance, origin, { ...intent, phase: 'preview' }, signal)
    if (preview.status === 'applied') {
      if (history?.applied !== preview.fingerprint || history.pending) await save({ contract, applied: preview.fingerprint })
      return { record, view: { status: 'applied', ...(history?.pending === preview.fingerprint ? { refresh: true } : {}) } }
    }
    if (preview.status !== 'prepared') return { record, view: { status: preview.status } }
    if (!intent.previous.includes(preview.observed)) return { record, view: { status: 'conflict' } }
    await save({ contract, applied: preview.observed, pending: preview.fingerprint })
    const currentGrant = () => this.access.issue(actor, instance, record.packageName, slotId, backend.id, signal)
    const matchesGrant = (current: Awaited<ReturnType<typeof currentGrant>>) =>
      current.token === grant.token && current.url === grant.url && current.model === grant.model && current.protocol === grant.protocol
    if (!matchesGrant(await currentGrant())) return { record, view: { status: 'conflict' } }
    const result = await this.transport.syncSettings(instance, origin, { ...intent, phase: 'apply', revision: preview.revision }, signal)
    if (result.status !== 'applied') return { record, view: { status: result.status === 'prepared' ? 'failed' : result.status } }
    if (result.fingerprint !== preview.fingerprint || !matchesGrant(await currentGrant())) return { record, view: { status: 'conflict' } }
    await save({ contract, applied: result.fingerprint })
    return { record, view: { status: 'applied', ...(result.refresh ? { refresh: true } : {}) } }
  }
}
