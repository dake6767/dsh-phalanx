import type { CommunityPluginUpstreamAction, CommunityPluginUpstreamInput, CommunityPluginUpstreamView } from '../domain/admin-contract.js'
import { BusinessRuleError } from '../domain/business-error.js'
import type { CommunityAccountActor } from '../domain/community-account.js'
import { CommunityAuthenticationError } from '../domain/community-account.js'
import type { ContributionReceipt } from '../domain/contribution-receipt.js'
import {
  imageUpstreamReady,
  managedImageUpstreamHeaders,
  managedImageUpstreamTest,
  mergeUpstreamInput,
  validImageCredential,
  type PluginUpstream,
} from '../domain/plugin-upstream.js'
import { deferredPluginUpstreams } from '../domain/suite-service-slots.js'
import type { LibraryPlugin } from '../domain/plugin-library.js'
import { suiteInstallOrigin } from '../domain/suite-install.js'
import type { CommunityAccountStorePort } from '../ports/community-accounts.js'
import type { PluginLibraryStorePort } from '../ports/plugin-library.js'
import type { PluginAccessStorePort } from '../ports/plugin-access.js'
import type { PluginUpstreamReferencesPort, PluginUpstreamsPort } from '../ports/plugin-upstreams.js'

function view(row: PluginUpstream): CommunityPluginUpstreamView {
  return {
    name: row.name,
    baseUrl: row.baseUrl,
    ...(row.model ? { model: row.model } : {}),
    headers: row.headers.map(header => ({ name: header.name, configured: !!header.value, last4: header.value.slice(-4) })),
    ...(row.testRequest ? { testRequest: { method: row.testRequest.method, configured: true as const } } : {}),
    credential: { configured: !!row.credential, last4: row.credential.slice(-4) },
  }
}

/** Credential write authority and redacted management projection. */
export class PluginUpstreamAdministration {
  constructor(
    private readonly accounts: Pick<CommunityAccountStorePort, 'get'>,
    private readonly library: Pick<PluginLibraryStorePort, 'list'>,
    private readonly store: PluginUpstreamsPort,
    private readonly references?: PluginUpstreamReferencesPort,
    private readonly services?: Pick<PluginAccessStorePort, 'installedServices'>,
    private readonly onManagedImageSaved?: (packageName: string) => Promise<void>,
  ) {}
  async list(actor: CommunityAccountActor, packageName: string): Promise<readonly CommunityPluginUpstreamView[]> {
    const plugin = await this.assertAdmin(actor, packageName)
    const snapshot = await this.store.snapshot?.(packageName)
    const rows = snapshot?.upstreams ?? (await this.store.list(packageName))
    const declared = new Set(await this.managedImages(plugin))
    const managedImage = (row?: PluginUpstream) => ({
      ready: imageUpstreamReady(row),
      ...(row?.imageDisabled ? { disabled: true as const } : {}),
      ...(row?.secretUnavailable ? { credentialUnavailable: true as const } : {}),
      ...(row?.unreadableHeaders?.length ? { unreadableHeaders: row.unreadableHeaders } : {}),
      ...(snapshot && plugin.revision !== undefined ? { revision: { upstream: snapshot.revision, plugin: plugin.revision } } : {}),
    })
    return [
      ...rows.map(row => {
        const projected = view(row)
        if (!declared.has(row.name)) return projected
        return {
          ...projected,
          headers: projected.headers.map(header => ({ ...header, last4: '' })),
          credential: { configured: validImageCredential(row.credential), last4: '' },
          managedImage: managedImage(row),
        }
      }),
      ...[...declared]
        .filter(name => !rows.some(row => row.name === name))
        .map(name => ({
          name,
          baseUrl: '',
          headers: [],
          credential: { configured: false, last4: '' },
          managedImage: managedImage(),
        })),
    ]
  }
  private async managedImages(plugin: LibraryPlugin) {
    if (!plugin.suiteOrigin || !plugin.current) return []
    const configuration = (await this.services?.installedServices?.(plugin.packageName))?.configuration
    return configuration?.ownerVersion === plugin.current.integrity && plugin.suiteOrigin === suiteInstallOrigin(configuration.identity.id)
      ? deferredPluginUpstreams(configuration.slots)
      : []
  }
  async execute(actor: CommunityAccountActor, packageName: string, input: CommunityPluginUpstreamAction) {
    const plugin = await this.assertAdmin(actor, packageName)
    if (!input || !['save', 'delete'].includes(input.action)) throw new BusinessRuleError('invalid', 'Invalid upstream action', 'plugin-upstream-invalid')
    const snapshot = await this.store.snapshot?.(packageName)
    const expectedRevision = snapshot?.revision ?? (await this.store.revision?.(packageName))
    const current = snapshot?.upstreams ?? (await this.store.list(packageName))
    const managed = new Set(await this.managedImages(plugin))
    if (input.action === 'delete') {
      if (!current.some(row => row.name === input.name)) throw new BusinessRuleError('missing', 'Upstream was not found', 'not-found')
      const references = managed.has(input.name) ? ['catalog'] : ((await this.references?.references(packageName, input.name)) ?? [])
      if (references.length)
        throw new BusinessRuleError('conflict', 'Upstream is still referenced by access settings', 'plugin-upstream-referenced', {
          locations: references.join(', '),
        })
      await this.store.save(
        packageName,
        current.filter(row => row.name !== input.name),
        undefined,
        expectedRevision,
        plugin.revision,
      )
    } else {
      if (!input.upstream || typeof input.upstream !== 'object') throw new BusinessRuleError('invalid', 'Invalid upstream action', 'plugin-upstream-invalid')
      const existing = current.find(row => row.name === input.upstream.name)
      const isManaged = managed.has(input.upstream.name)
      const stale = isManaged
        ? !snapshot || input.expectedRevision?.upstream !== snapshot.revision || input.expectedRevision?.plugin !== plugin.revision
        : input.expectedRevision !== undefined
      if (stale) throw new BusinessRuleError('conflict', 'Platform configuration changed. Reload before saving.', 'platform-configuration-conflict')
      if (input.enabled !== undefined && (!isManaged || typeof input.enabled !== 'boolean'))
        throw new BusinessRuleError('invalid', 'Invalid upstream action', 'plugin-upstream-invalid')
      if (isManaged && input.upstream.credential && !validImageCredential(input.upstream.credential))
        throw new BusinessRuleError('invalid', 'Enter a valid API key.', 'plugin-upstream-invalid')
      let managedHeaders = existing?.headers ?? managedImageUpstreamHeaders
      if (isManaged && existing?.secretUnavailable) {
        const unreadable = new Set(existing.unreadableHeaders ?? existing.headers.filter(header => !header.value).map(header => header.name))
        const submitted = Array.isArray(input.upstream.headers) ? input.upstream.headers : []
        managedHeaders = existing.headers.map(header =>
          unreadable.has(header.name) ? { name: header.name, value: submitted.find(row => row?.name === header.name)?.value ?? '' } : header,
        )
      }
      let next: PluginUpstream = isManaged
        ? {
            ...mergeUpstreamInput(
              {
                name: input.upstream.name,
                baseUrl: input.upstream.baseUrl,
                ...(input.upstream.model === undefined ? {} : { model: input.upstream.model }),
                ...(input.upstream.credential === undefined ? {} : { credential: input.upstream.credential }),
                ...(input.upstream.clearCredential ? { clearCredential: true } : {}),
                headers: managedHeaders,
                testRequest: existing?.testRequest ?? managedImageUpstreamTest,
              },
              existing,
            ),
            nativeServiceOnly: true,
          }
        : mergeUpstreamInput(input.upstream, existing)
      if (input.enabled !== undefined) {
        const { imageDisabled, ...configuration } = next
        void imageDisabled
        if (input.enabled && !imageUpstreamReady(configuration))
          throw new BusinessRuleError('invalid', 'Complete the required fields.', 'plugin-upstream-invalid')
        next = input.enabled ? configuration : { ...configuration, imageDisabled: true }
      }
      await this.store.save(packageName, [...current.filter(row => row.name !== next.name), next], undefined, expectedRevision, plugin.revision)
      if (isManaged && (imageUpstreamReady(next) || imageUpstreamReady(existing))) await this.onManagedImageSaved?.(packageName)
    }
    return await this.list(actor, packageName)
  }
  async contributionRevision(packageName: string) {
    return (await this.store.revision?.(packageName)) ?? 'unsupported'
  }
  async contributionApplied(packageName: string, receipt: ContributionReceipt) {
    const current = await this.store.receipt?.(packageName)
    return current?.id === receipt.id && current.revision === receipt.revision
  }
  async skipContribution(packageName: string, receipt: ContributionReceipt, warnings: readonly string[]): Promise<readonly string[]> {
    if (await this.contributionApplied(packageName, receipt)) return (await this.store.receipt?.(packageName))?.warnings ?? []
    await this.store.save(packageName, await this.store.list(packageName), { ...receipt, warnings })
    return warnings
  }
  async contributionList(actor: CommunityAccountActor, packageName: string): Promise<readonly CommunityPluginUpstreamView[]> {
    await this.assertActor(actor)
    return (await this.store.list(packageName)).map(view)
  }
  /** Apply a validated contribution draft through the caller repositories; browser writes use execute(). */
  async adoptContribution(packageName: string, inputs: readonly CommunityPluginUpstreamInput[], receipt: ContributionReceipt): Promise<readonly string[]> {
    const plugin = (await this.library.list()).find(row => row.packageName === packageName && !row.removing)
    if (!plugin) throw new BusinessRuleError('missing', 'Plugin was not found', 'not-found')
    const applied = await this.store.receipt?.(packageName)
    if (applied?.id === receipt.id && applied.revision === receipt.revision) return applied.warnings ?? []
    const current = new Map((await this.store.list(packageName)).map(row => [row.name, row]))
    const managed = new Set(await this.managedImages(plugin))
    for (const input of inputs) {
      const next = mergeUpstreamInput(input, current.get(input.name))
      current.set(input.name, managed.has(input.name) ? { ...next, nativeServiceOnly: true } : next)
    }
    await this.store.save(packageName, [...current.values()], receipt)
    return []
  }
  private async assertAdmin(actor: CommunityAccountActor, packageName: string): Promise<LibraryPlugin> {
    await this.assertActor(actor)
    const plugin = (await this.library.list()).find(row => row.packageName === packageName && !row.removing)
    if (!plugin) throw new BusinessRuleError('missing', 'Plugin was not found', 'not-found')
    return plugin
  }
  private async assertActor(actor: CommunityAccountActor): Promise<void> {
    const current = await this.accounts.get(actor.username)
    if (!current || current.disabled || current.spaceId !== actor.spaceId || current.sessionEpoch !== actor.sessionEpoch)
      throw new CommunityAuthenticationError('Sign in is required', 'sign-in-required')
    if (!current.admin) throw new BusinessRuleError('forbidden', 'Administrator access is required', 'admin-required')
  }
}
