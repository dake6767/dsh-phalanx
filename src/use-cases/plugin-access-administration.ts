import type { CommunityAccountActor } from '../domain/community-account.js'
import { CommunityAuthenticationError } from '../domain/community-account.js'
import { BusinessRuleError } from '../domain/business-error.js'
import type { CommunityPluginAccessInput, CommunityPluginAccessView } from '../domain/admin-contract.js'
import { reservedPluginEnvironment } from '../domain/plugin-access.js'
import type { CommunityAccountStorePort } from '../ports/community-accounts.js'
import type { PluginLibraryStorePort } from '../ports/plugin-library.js'
import type { PluginAccessStorePort, PluginAccessSyntaxPort } from '../ports/plugin-access.js'
import type { PluginUpstreamsPort, PluginUpstreamReferencesPort } from '../ports/plugin-upstreams.js'

/** One owner for access validation, reference discovery and administrator projection. */
export class PluginAccessAdministration implements PluginUpstreamReferencesPort {
  constructor(private readonly accounts: Pick<CommunityAccountStorePort, 'get'>, private readonly library: Pick<PluginLibraryStorePort, 'list'>,
    private readonly store: PluginAccessStorePort, private readonly upstreams: Pick<PluginUpstreamsPort, 'list'>, private readonly syntax: PluginAccessSyntaxPort) {}
  view(actor: CommunityAccountActor, packageName: string): CommunityPluginAccessView {
    this.assertAdmin(actor, packageName)
    const settings = this.store.get(packageName), entryIds = this.entryIds(packageName)
    return { environment: settings?.environment ?? [], entriesYaml: settings?.entriesYaml ?? '', configured: !!settings, entryIds,
      invalidEntryIds: Object.keys(settings?.entries ?? {}).filter(id => !entryIds.includes(id)) }
  }
  summary(packageName: string) {
    const settings = this.store.get(packageName), entryIds = settings ? this.entryIds(packageName) : []
    return { accessConfigured: !!settings, invalidAccessEntries: Object.keys(settings?.entries ?? {}).filter(id => !entryIds.includes(id)), hasPlatformCredential: this.upstreams.list(packageName).some(row => row.credential.length > 0) }
  }
  save(actor: CommunityAccountActor, packageName: string, input: CommunityPluginAccessInput): CommunityPluginAccessView {
    this.assertAdmin(actor, packageName)
    const fail = (reason: string): never => { throw new BusinessRuleError('invalid', 'Invalid plugin access settings', 'plugin-access-invalid', { reason }) }
    if (!input || typeof input.entriesYaml !== 'string' || input.entriesYaml.length > 64 * 1024 || !Array.isArray(input.environment) || input.environment.length > 128) fail('shape')
    let entries
    try { entries = this.syntax.parse(input.entriesYaml) } catch { return fail('yaml') }
    const entryIds = this.entryIds(packageName)
    if (Object.keys(entries).some(id => !entryIds.includes(id))) fail('entry')
    const occupied = new Set(Object.entries(this.store.list()).filter(([name]) => name !== packageName).flatMap(([, settings]) => settings.environment.map(row => row.name)))
    const names = new Set<string>()
    for (const row of input.environment) {
      if (!row || typeof row.name !== 'string' || !/^[a-zA-Z_][a-zA-Z0-9_]*$/u.test(row.name) || typeof row.value !== 'string' || row.value.length > 65536) fail('environment')
      if (reservedPluginEnvironment(row.name)) fail('reserved')
      if (occupied.has(row.name) || names.has(row.name)) fail('duplicate')
      names.add(row.name)
    }
    const upstreams = new Set(this.upstreams.list(packageName).map(row => row.name))
    for (const { name } of this.referencesIn({ environment: input.environment, entries })) if (!upstreams.has(name)) fail('upstream')
    if (!input.environment.length && !Object.keys(entries).length) this.store.remove(packageName)
    else this.store.save(packageName, { environment: input.environment, entriesYaml: input.entriesYaml, entries })
    return this.view(actor, packageName)
  }
  references(packageName: string, upstreamName: string): readonly string[] {
    const settings = this.store.get(packageName)
    return settings ? this.referencesIn(settings).filter(row => row.name === upstreamName).map(row => row.location) : []
  }
  private referencesIn(settings: { readonly environment: CommunityPluginAccessInput['environment'], readonly entries: unknown }) {
    const found: Array<{ name: string, location: string }> = []
    const walk = (value: unknown, location: string) => {
      if (typeof value === 'string') for (const match of value.matchAll(/\{upstream:([^{}]*)\}/gu)) found.push({ name: match[1]!, location })
      else if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) walk(item, `${location}.${key}`)
    }
    for (const row of settings.environment) walk(row.value, `environment.${row.name}`)
    walk(settings.entries, 'entries')
    return found
  }
  private entryIds(packageName: string) {
    const plugin = this.library.list().find(row => row.packageName === packageName)?.current
    return plugin ? this.syntax.entryIds(plugin) : []
  }
  private assertAdmin(actor: CommunityAccountActor, packageName: string) {
    const account = this.accounts.get(actor.username)
    if (!account || account.disabled || account.spaceId !== actor.spaceId || account.sessionEpoch !== actor.sessionEpoch) throw new CommunityAuthenticationError('Sign in is required', 'sign-in-required')
    if (!account.admin) throw new BusinessRuleError('forbidden', 'Administrator access is required', 'admin-required')
    if (!this.library.list().some(row => row.packageName === packageName && !row.removing)) throw new BusinessRuleError('missing', 'Plugin was not found', 'not-found')
  }
}
