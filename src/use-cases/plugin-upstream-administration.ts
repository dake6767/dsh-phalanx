import type { CommunityAccountActor } from '../domain/community-account.js'
import { CommunityAuthenticationError } from '../domain/community-account.js'
import type { CommunityPluginUpstreamAction, CommunityPluginUpstreamView } from '../domain/admin-contract.js'
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
    return this.store.list(packageName).map(row => ({ name: row.name, baseUrl: row.baseUrl, headers: row.headers, hasCredential: row.credential.length > 0 }))
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
        credential: input.upstream.credential ?? prior?.credential ?? '' }
      this.store.save(packageName, [...current.filter(row => row.name !== next.name), next])
    }
    return this.list(actor, packageName)
  }
  private assertAdmin(actor: CommunityAccountActor, packageName: string): void {
    const current = this.accounts.get(actor.username)
    if (!current || current.disabled || current.spaceId !== actor.spaceId || current.sessionEpoch !== actor.sessionEpoch) throw new CommunityAuthenticationError('Sign in is required', 'sign-in-required')
    if (!current.admin) throw new BusinessRuleError('forbidden', 'Administrator access is required', 'admin-required')
    if (!this.library.list().some(row => row.packageName === packageName && !row.removing)) throw new BusinessRuleError('missing', 'Plugin was not found', 'not-found')
  }
}
