import type { CommunityAccountRecord, CommunityCreateAccountInput } from '../domain/community-account.js'
import { BusinessRuleError } from '../domain/business-error.js'
import type { CommunityAccountOnboardingStorePort } from '../ports/community-accounts.js'
import type { BootstrapCredentialPort } from '../ports/bootstrap-credential.js'

/** Bootstrap and administrator-created membership; never grants admin through member input. */
export class CommunityOnboarding {
  constructor(
    private readonly accounts: CommunityAccountOnboardingStorePort,
    private readonly credential: BootstrapCredentialPort,
  ) {}

  async bootstrapComplete(): Promise<boolean> {
    return await this.accounts.bootstrapComplete()
  }
  async activeUsernames(): Promise<ReadonlySet<string>> {
    return new Set((await this.accounts.list()).filter(account => !account.disabled).map(account => account.username))
  }
  authorizeBootstrap(value: string): void {
    if (!this.credential.verify(value)) throw new BusinessRuleError('forbidden', 'Invalid or expired bootstrap credential', 'bootstrap-credential-invalid')
  }
  async bootstrap(value: string, input: CommunityCreateAccountInput): Promise<CommunityAccountRecord> {
    if (await this.bootstrapComplete()) throw new BusinessRuleError('missing', 'Not Found', 'not-found')
    this.authorizeBootstrap(value)
    const account = await this.accounts.createFirstAdmin(input)
    this.credential.consume()
    return account
  }
  async createMember(actor: string, input: CommunityCreateAccountInput) {
    await this.assertAdmin(actor)
    return await this.accounts.create(input)
  }
  async list(actor: string) {
    await this.assertAdmin(actor)
    return await this.accounts.list()
  }
  async viewer(actor: string) {
    return await this.assertAdmin(actor)
  }

  private async assertAdmin(actor: string): Promise<CommunityAccountRecord> {
    const account = await this.accounts.get(actor)
    if (account?.admin !== true || account.disabled) throw new BusinessRuleError('forbidden', 'Administrator access is required', 'admin-required')
    return account
  }
}
