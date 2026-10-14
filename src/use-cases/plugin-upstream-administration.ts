import type { CommunityAccountActor } from '../domain/community-account.js'
import { CommunityAuthenticationError } from '../domain/community-account.js'
import type { CommunityPluginUpstreamAction, CommunityPluginUpstreamInput, CommunityPluginUpstreamView } from '../domain/admin-contract.js'
import { BusinessRuleError } from '../domain/business-error.js'
import { upstreamInput } from '../domain/plugin-upstream.js'
import type { CommunityAccountStorePort } from '../ports/community-accounts.js'
import type { PluginLibraryStorePort } from '../ports/plugin-library.js'
import type { PluginUpstreamsPort, PluginUpstreamReferencesPort } from '../ports/plugin-upstreams.js'

/** Credential write authority and redacted management projection. */
export class PluginUpstreamAdministration {
  constructor(private readonly accounts: Pick<CommunityAccountStorePort, 'get'>,
    private readonly library: Pick<PluginLibraryStorePort, 'list'>, private readonly store: PluginUpstreamsPort,
    private readonly references?: PluginUpstreamReferencesPort) {}
  list(actor: CommunityAccountActor, packageName: string): readonly CommunityPluginUpstreamView[] {
    this.assertAdmin(actor, packageName)
    return this.store.list(packageName).map(row => ({ name: row.name, baseUrl: row.baseUrl, headers: row.headers, ...(row.testRequest ? { testRequest: row.testRequest } : {}), hasCredential: row.credential.length > 0 }))
  }
  execute(actor: CommunityAccountActor, packageName: string, input: CommunityPluginUpstreamAction) {
    this.assertAdmin(actor, packageName)
    const current = this.store.list(packageName)
    if (!input || !['save', 'delete'].includes(input.action)) throw new BusinessRuleError('invalid', 'Invalid upstream action', 'plugin-upstream-invalid')
    if (input.action === 'delete') {
      if (!current.some(row => row.name === input.name)) throw new BusinessRuleError('missing', 'Upstream was not found', 'not-found')
      const references = this.references?.references(packageName, input.name) ?? []
      if (references.length) throw new BusinessRuleError('conflict', 'Upstream is still referenced by access settings', 'plugin-upstream-referenced', { locations: references.join(', ') })
      this.store.save(packageName, current.filter(row => row.name !== input.name))
    } else {
      upstreamInput(input.upstream)
      const prior = current.find(row => row.name === input.upstream.name)
      const next = { name: input.upstream.name, baseUrl: input.upstream.baseUrl, headers: input.upstream.headers,
        credential: input.upstream.credential ?? prior?.credential ?? '',
        ...(input.upstream.testRequest !== undefined ? { testRequest: input.upstream.testRequest } : prior?.testRequest ? { testRequest: prior.testRequest } : {}) }
      this.store.save(packageName, [...current.filter(row => row.name !== next.name), next])
    }
    return this.list(actor, packageName)
  }
  contributionList(actor: CommunityAccountActor, packageName: string): readonly CommunityPluginUpstreamView[] {
    this.assertActor(actor)
    return this.store.list(packageName).map(({ name, baseUrl, headers, testRequest, credential }) => ({ name, baseUrl, headers, ...(testRequest ? { testRequest } : {}), hasCredential: credential.length > 0 }))
  }
  /** Replay an already authorized contribution intent; browser writes use execute(). */
  adoptContribution(packageName: string, inputs: readonly CommunityPluginUpstreamInput[], receipt: { readonly id: string, readonly revision: string }): void {
    if (!this.library.list().some(row => row.packageName === packageName && !row.removing)) throw new BusinessRuleError('missing', 'Plugin was not found', 'not-found')
    const applied = this.store.receipt?.(packageName)
    if (applied?.id === receipt.id && applied.revision === receipt.revision) return
    const current = new Map(this.store.list(packageName).map(row => [row.name, row]))
    for (const input of inputs) {
      upstreamInput(input)
      const prior = current.get(input.name)
      current.set(input.name, { name: input.name, baseUrl: input.baseUrl, headers: input.headers, credential: input.credential ?? prior?.credential ?? '', ...(input.testRequest ? { testRequest: input.testRequest } : prior?.testRequest ? { testRequest: prior.testRequest } : {}) })
    }
    this.store.save(packageName, [...current.values()], receipt)
  }
  private assertAdmin(actor: CommunityAccountActor, packageName: string): void {
    this.assertActor(actor)
    if (!this.library.list().some(row => row.packageName === packageName && !row.removing)) throw new BusinessRuleError('missing', 'Plugin was not found', 'not-found')
  }
  private assertActor(actor: CommunityAccountActor): void {
    const current = this.accounts.get(actor.username)
    if (!current || current.disabled || current.spaceId !== actor.spaceId || current.sessionEpoch !== actor.sessionEpoch) throw new CommunityAuthenticationError('Sign in is required', 'sign-in-required')
    if (!current.admin) throw new BusinessRuleError('forbidden', 'Administrator access is required', 'admin-required')
  }
}
