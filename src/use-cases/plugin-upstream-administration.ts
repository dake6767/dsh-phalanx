import type { CommunityPluginUpstreamAction, CommunityPluginUpstreamInput, CommunityPluginUpstreamView } from '../domain/admin-contract.js'
import { BusinessRuleError } from '../domain/business-error.js'
import type { CommunityAccountActor } from '../domain/community-account.js'
import { CommunityAuthenticationError } from '../domain/community-account.js'
import type { ContributionReceipt } from '../domain/contribution-receipt.js'
import { mergeUpstreamInput, type PluginUpstream } from '../domain/plugin-upstream.js'
import type { CommunityAccountStorePort } from '../ports/community-accounts.js'
import type { PluginLibraryStorePort } from '../ports/plugin-library.js'
import type { PluginUpstreamReferencesPort, PluginUpstreamsPort } from '../ports/plugin-upstreams.js'

function view(row: PluginUpstream): CommunityPluginUpstreamView {
  return {
    name: row.name,
    baseUrl: row.baseUrl,
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
  ) {}
  async list(actor: CommunityAccountActor, packageName: string): Promise<readonly CommunityPluginUpstreamView[]> {
    await this.assertAdmin(actor, packageName)
    return (await this.store.list(packageName)).map(view)
  }
  async execute(actor: CommunityAccountActor, packageName: string, input: CommunityPluginUpstreamAction) {
    await this.assertAdmin(actor, packageName)
    const expectedRevision = await this.store.revision?.(packageName)
    const current = await this.store.list(packageName)
    if (!input || !['save', 'delete'].includes(input.action)) throw new BusinessRuleError('invalid', 'Invalid upstream action', 'plugin-upstream-invalid')
    if (input.action === 'delete') {
      if (!current.some(row => row.name === input.name)) throw new BusinessRuleError('missing', 'Upstream was not found', 'not-found')
      const references = (await this.references?.references(packageName, input.name)) ?? []
      if (references.length)
        throw new BusinessRuleError('conflict', 'Upstream is still referenced by access settings', 'plugin-upstream-referenced', {
          locations: references.join(', '),
        })
      await this.store.save(
        packageName,
        current.filter(row => row.name !== input.name),
        undefined,
        expectedRevision,
      )
    } else {
      const next = mergeUpstreamInput(
        input.upstream,
        current.find(row => row.name === input.upstream.name),
      )
      await this.store.save(packageName, [...current.filter(row => row.name !== next.name), next], undefined, expectedRevision)
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
    if (!(await this.library.list()).some(row => row.packageName === packageName && !row.removing))
      throw new BusinessRuleError('missing', 'Plugin was not found', 'not-found')
    const applied = await this.store.receipt?.(packageName)
    if (applied?.id === receipt.id && applied.revision === receipt.revision) return applied.warnings ?? []
    const current = new Map((await this.store.list(packageName)).map(row => [row.name, row]))
    for (const input of inputs) {
      current.set(input.name, mergeUpstreamInput(input, current.get(input.name)))
    }
    await this.store.save(packageName, [...current.values()], receipt)
    return []
  }
  private async assertAdmin(actor: CommunityAccountActor, packageName: string): Promise<void> {
    await this.assertActor(actor)
    if (!(await this.library.list()).some(row => row.packageName === packageName && !row.removing))
      throw new BusinessRuleError('missing', 'Plugin was not found', 'not-found')
  }
  private async assertActor(actor: CommunityAccountActor): Promise<void> {
    const current = await this.accounts.get(actor.username)
    if (!current || current.disabled || current.spaceId !== actor.spaceId || current.sessionEpoch !== actor.sessionEpoch)
      throw new CommunityAuthenticationError('Sign in is required', 'sign-in-required')
    if (!current.admin) throw new BusinessRuleError('forbidden', 'Administrator access is required', 'admin-required')
  }
}
