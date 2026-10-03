import type { CommunityCreateAccountInput } from '../domain/community-account.js'
import { BusinessRuleError } from '../domain/business-error.js'
import type { CommunityAccountOnboardingStorePort } from '../ports/community-accounts.js'
import type { BootstrapCredentialPort } from '../ports/bootstrap-credential.js'

/** Bootstrap and administrator-created membership; never grants admin through member input. */
export class CommunityOnboarding {
  constructor(private readonly accounts: CommunityAccountOnboardingStorePort,
    private readonly credential: BootstrapCredentialPort) {}

  bootstrapComplete(): boolean { return this.accounts.bootstrapComplete() }
  activeUsernames(): ReadonlySet<string> { return new Set(this.accounts.list().filter(account => !account.disabled).map(account => account.username)) }
  async bootstrap(value: string, input: CommunityCreateAccountInput): Promise<void> {
    if (this.bootstrapComplete()) throw new BusinessRuleError('missing', 'Not Found')
    if (!this.credential.verify(value)) throw new BusinessRuleError('forbidden', 'Invalid or expired bootstrap credential')
    await this.accounts.createFirstAdmin(input)
    this.credential.consume()
  }
  async createMember(actor: string, input: CommunityCreateAccountInput) {
    this.assertAdmin(actor)
    return await this.accounts.create(input)
  }
  list(actor: string) { this.assertAdmin(actor); return this.accounts.list() }
  viewer(actor: string) { this.assertAdmin(actor); return this.accounts.get(actor)! }

  private assertAdmin(actor: string): void {
    const account = this.accounts.get(actor)
    if (account?.admin !== true || account.disabled) throw new BusinessRuleError('forbidden', 'Administrator access is required')
  }
}
