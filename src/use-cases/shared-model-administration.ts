import type { CommunityAccountActor } from '../domain/community-account.js'
import { CommunityAuthenticationError } from '../domain/community-account.js'
import type { CommunityModelAction, CommunityModelSettings, CommunityProviderInput } from '../domain/admin-contract.js'
import { BusinessRuleError } from '../domain/business-error.js'
import { enabledSharedModels, sharedModelSettings, type SharedProvider } from '../domain/shared-models.js'
import type { CommunityAccountStorePort } from '../ports/community-accounts.js'
import type { SharedModelStorePort } from '../ports/shared-models.js'

/** Shared supply decisions; no credential-bearing response leaves this owner. */
export class SharedModelAdministration {
  constructor(private readonly accounts: Pick<CommunityAccountStorePort, 'get'>, private readonly store: SharedModelStorePort) {}
  configured(): boolean { return enabledSharedModels(this.store.read()).length > 0 }
  list(actor: CommunityAccountActor): CommunityModelSettings { this.assertAdmin(actor); return sharedModelSettings(this.store.read()) }
  execute(actor: CommunityAccountActor, input: CommunityModelAction): CommunityModelSettings {
    this.assertAdmin(actor)
    const current = this.store.read()
    if (input.revision !== current.revision) throw new BusinessRuleError('conflict', 'Model settings changed. Reload before saving.', 'model-revision-conflict', { expectedRevision: current.revision, receivedRevision: input.revision })
    let providers = [...current.providers]
    if (input.action === 'save-provider') {
      const existing = providers.find(provider => provider.id === input.provider.id)
      if (input.provider.id !== undefined && existing === undefined) throw new BusinessRuleError('missing', 'Provider was not found', 'provider-not-found')
      const provider = this.provider(input.provider, existing)
      providers = [...providers.filter(row => row.id !== provider.id), provider]
    } else if (input.action === 'delete-provider') {
      if (!providers.some(provider => provider.id === input.providerId)) throw new BusinessRuleError('missing', 'Provider was not found', 'provider-not-found')
      providers = providers.filter(provider => provider.id !== input.providerId)
    }
    const next = { revision: current.revision + 1, providers, defaultModelId: input.defaultModelId === undefined ? current.defaultModelId : input.defaultModelId }
    const enabled = enabledSharedModels(next)
    if (next.defaultModelId === null && current.defaultModelId === null && enabled.length > 0) next.defaultModelId = enabled[0]!.model.id
    if ((next.defaultModelId !== null && !enabled.some(row => row.model.id === next.defaultModelId))
      || ((enabled.length > 0 || current.defaultModelId !== null) && next.defaultModelId === null)) throw new BusinessRuleError('invalid', 'Choose an enabled replacement default before disabling or deleting the current default.', 'model-default-required')
    this.store.save(next)
    return sharedModelSettings(next)
  }
  private provider(input: CommunityProviderInput, existing?: SharedProvider): SharedProvider {
    const invalid = () => new BusinessRuleError('invalid', 'Provide a name, an HTTP(S) Messages Base URL, a valid key and distinct model identifiers.', 'provider-invalid')
    if (typeof input.name !== 'string' || input.name.trim() === '' || input.name.length > 128
      || input.apiFormat !== 'anthropic-messages' || typeof input.enabled !== 'boolean' || !Array.isArray(input.models)) throw invalid()
    let url: URL
    try { url = new URL(input.baseUrl) } catch { throw invalid() }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw invalid()
    const apiKey = input.apiKey === undefined || input.apiKey === '' ? existing?.apiKey : input.apiKey
    if (typeof apiKey !== 'string' || apiKey.trim() === '' || /[^\x20-\x7e]/u.test(apiKey)) throw invalid()
    const seen = new Set<string>(); const ids = new Set<string>()
    const models = input.models.map(model => {
      if (typeof model.name !== 'string' || model.name.trim() === '' || model.name.length > 256 || typeof model.enabled !== 'boolean' || seen.has(model.name)) throw invalid()
      seen.add(model.name)
      const prior = existing?.models.find(row => model.id === undefined ? row.name === model.name : row.id === model.id)
      if (model.id !== undefined && prior === undefined) throw invalid()
      const id = prior?.id ?? this.store.newId()
      if (ids.has(id)) throw invalid(); ids.add(id)
      return { id, name: model.name, enabled: model.enabled }
    })
    return { id: existing?.id ?? this.store.newId(), name: input.name.trim(), baseUrl: url.href.replace(/\/+$/u, ''), apiKey,
      apiFormat: 'anthropic-messages', enabled: input.enabled, models }
  }
  private assertAdmin(actor: CommunityAccountActor): void {
    const current = this.accounts.get(actor.username)
    if (current === undefined || current.disabled || current.spaceId !== actor.spaceId || current.sessionEpoch !== actor.sessionEpoch) throw new CommunityAuthenticationError('Sign in is required', 'sign-in-required')
    if (!current.admin) throw new BusinessRuleError('forbidden', 'Administrator access is required', 'admin-required')
  }
}
