import { BusinessRuleError } from '../domain/business-error.js'
import { CommunityAuthenticationError, type CommunityAccountActor } from '../domain/community-account.js'
import type { CommunityAccountReaderPort } from '../ports/community-accounts.js'
import type { PlatformSearchSettingsStore } from '../ports/platform-search-settings.js'

export class PlatformSearchSettings {
  constructor(
    private readonly accounts: Pick<CommunityAccountReaderPort, 'get'>,
    private readonly store: PlatformSearchSettingsStore,
  ) {}

  async view(actor: CommunityAccountActor) {
    await this.assertAdmin(actor)
    return await this.store.view()
  }

  async save(actor: CommunityAccountActor, input: unknown) {
    await this.assertAdmin(actor)
    const invalid = () => new BusinessRuleError('invalid', 'Check the platform search settings and try again.', 'platform-search-settings-invalid')
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalid()
    const { action, revision, enabled, apiKey } = input as Record<string, unknown>
    if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 0) throw invalid()
    if (action === 'clear' && enabled === undefined && apiKey === undefined) return await this.store.save({ action, revision })
    if (action !== 'save' || typeof enabled !== 'boolean') throw invalid()
    if (apiKey !== undefined && (typeof apiKey !== 'string' || !/^[\x21-\x7e]{1,2048}$/u.test(apiKey))) throw invalid()
    return await this.store.save({ action, revision, enabled, ...(apiKey === undefined ? {} : { apiKey }) })
  }

  private async assertAdmin(actor: CommunityAccountActor) {
    const current = await this.accounts.get(actor.username)
    if (!current || current.disabled || current.spaceId !== actor.spaceId || current.sessionEpoch !== actor.sessionEpoch)
      throw new CommunityAuthenticationError('Sign in is required', 'sign-in-required')
    if (!current.admin) throw new BusinessRuleError('forbidden', 'Administrator access is required', 'admin-required')
  }
}
