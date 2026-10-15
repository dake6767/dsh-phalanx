import { BusinessRuleError } from '../domain/business-error.js'
import { CommunityAuthenticationError, type CommunityAccountActor } from '../domain/community-account.js'
import { downloadSourceSelection, downloadSourcePresets, resolveDownloadSources } from '../domain/download-source.js'
import type { CommunityDownloadSourcesView } from '../domain/admin-contract.js'
import type { CommunityAccountReaderPort } from '../ports/community-accounts.js'
import type { DownloadSourceReaderPort, DownloadSourceStorePort } from '../ports/download-sources.js'

/** The sole writer of deployment-wide download choices; no credentials are accepted. */
export class DownloadSources implements DownloadSourceReaderPort {
  constructor(private readonly accounts: Pick<CommunityAccountReaderPort, 'get'>, private readonly store: DownloadSourceStorePort) {}
  current() { return resolveDownloadSources(this.store.get()) }
  view(actor: CommunityAccountActor): CommunityDownloadSourcesView {
    this.assertAdmin(actor)
    return { ...this.store.get(), sources: this.current(), presets: structuredClone(downloadSourcePresets) }
  }
  save(actor: CommunityAccountActor, input: unknown): CommunityDownloadSourcesView {
    this.assertAdmin(actor)
    this.store.save(downloadSourceSelection(input))
    return this.view(actor)
  }
  private assertAdmin(actor: CommunityAccountActor): void {
    const current = this.accounts.get(actor.username)
    if (!current || current.disabled || current.spaceId !== actor.spaceId || current.sessionEpoch !== actor.sessionEpoch)
      throw new CommunityAuthenticationError('Sign in is required', 'sign-in-required')
    if (!current.admin) throw new BusinessRuleError('forbidden', 'Administrator access is required', 'admin-required')
  }
}
