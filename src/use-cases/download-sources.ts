import { BusinessRuleError } from '../domain/business-error.js'
import { CommunityAuthenticationError, type CommunityAccountActor } from '../domain/community-account.js'
import { downloadSourceSelection, downloadSourcePresets, resolveDownloadSources } from '../domain/download-source.js'
import type { CommunityDownloadSourcesView } from '../domain/admin-contract.js'
import type { CommunityAccountReaderPort } from '../ports/community-accounts.js'
import type { DownloadSourceReaderPort, DownloadSourceStorePort } from '../ports/download-sources.js'

/** The sole writer of deployment-wide download choices; no credentials are accepted. */
export class DownloadSources implements DownloadSourceReaderPort {
  constructor(
    private readonly accounts: Pick<CommunityAccountReaderPort, 'get'>,
    private readonly store: DownloadSourceStorePort,
  ) {}
  current() {
    return resolveDownloadSources(this.selection())
  }
  async view(actor: CommunityAccountActor): Promise<CommunityDownloadSourcesView> {
    await this.assertAdmin(actor)
    return { ...this.selection(), sources: this.current(), presets: structuredClone(downloadSourcePresets) }
  }
  async save(actor: CommunityAccountActor, input: unknown): Promise<CommunityDownloadSourcesView> {
    await this.assertAdmin(actor)
    await this.store.save(downloadSourceSelection(input))
    return await this.view(actor)
  }
  /** The effective selection, without the store's saved-or-installed marker. */
  private selection() {
    const { preset, overrides } = this.store.get()
    return { preset, ...(overrides ? { overrides } : {}) }
  }
  private async assertAdmin(actor: CommunityAccountActor): Promise<void> {
    const current = await this.accounts.get(actor.username)
    if (!current || current.disabled || current.spaceId !== actor.spaceId || current.sessionEpoch !== actor.sessionEpoch)
      throw new CommunityAuthenticationError('Sign in is required', 'sign-in-required')
    if (!current.admin) throw new BusinessRuleError('forbidden', 'Administrator access is required', 'admin-required')
  }
}
