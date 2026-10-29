import { BusinessRuleError } from '../domain/business-error.js'
import { CommunityAuthenticationError, type CommunityAccountActor } from '../domain/community-account.js'
import type { CommunityAccountStorePort } from '../ports/community-accounts.js'
import type { CommunitySystemStatusPort } from '../ports/community-system-status.js'

/** System metadata and backup acknowledgements require a current administrator on every call. */
export class CommunitySystemStatus {
  constructor(
    private readonly accounts: Pick<CommunityAccountStorePort, 'get'>,
    private readonly status: CommunitySystemStatusPort,
  ) {}
  async view(actor: CommunityAccountActor) {
    await this.assertAdmin(actor)
    return await this.status.read()
  }
  async confirmBackup(actor: CommunityAccountActor, fingerprint: string) {
    await this.assertAdmin(actor)
    if (typeof fingerprint !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(fingerprint))
      throw new BusinessRuleError('invalid', 'Choose the displayed master-key fingerprint.', 'master-key-fingerprint-required')
    return await this.status.confirmBackup(fingerprint, { username: actor.username, spaceId: actor.spaceId })
  }
  private async assertAdmin(actor: CommunityAccountActor): Promise<void> {
    const current = await this.accounts.get(actor.username)
    if (!current || current.disabled || current.spaceId !== actor.spaceId || current.sessionEpoch !== actor.sessionEpoch)
      throw new CommunityAuthenticationError('Sign in is required', 'sign-in-required')
    if (!current.admin) throw new BusinessRuleError('forbidden', 'Administrator access is required', 'admin-required')
  }
}
