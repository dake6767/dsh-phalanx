import type { CommunityExpertLibrary, CommunityExpertGroup, CommunityExpertMarket } from '../domain/admin-contract.js'
import { assertExpertInput, expertPresetId, type Expert, type ExpertInput, type ExpertModelChoice } from '../domain/expert.js'
import { CommunityAuthenticationError, type CommunityAccountActor } from '../domain/community-account.js'
import { BusinessRuleError } from '../domain/business-error.js'
import { assertOrdinaryGroup, requiredCommunityGroup } from '../domain/community-group.js'
import type { CommunityAccountStorePort } from '../ports/community-accounts.js'
import type { ExpertStorePort, ExpertSkillsPort, ExpertMcpPort, MemberExpertsPort } from '../ports/experts.js'
import type { SkillLibraryStorePort } from '../ports/skill-library.js'
import type { SkillPackStorePort } from '../ports/skill-packs.js'
import type { CommunityRuntimePort } from '../ports/community-runtime.js'
import type { LibraryPlugin, PreparedPlugin } from '../domain/plugin-library.js'

/** Expert definitions and current ownership; running preset snapshots are owned by the runtime. */
export class Experts implements ExpertSkillsPort, ExpertMcpPort, MemberExpertsPort {
  constructor(private readonly accounts: Pick<CommunityAccountStorePort, 'get' | 'list' | 'listGroups'>,
    private readonly store: ExpertStorePort, private readonly library: Pick<SkillLibraryStorePort, 'list'>,
    private readonly packs: Pick<SkillPackStorePort, 'list'>, private readonly newId: () => string,
    private readonly changed: () => Promise<void> = async () => {}, private readonly globalSkills: (username: string) => readonly string[] = () => [],
    private readonly runtime?: Pick<CommunityRuntimePort, 'status'>,
    private readonly pluginSource?: { list(): readonly LibraryPlugin[], eligible(plugin: PreparedPlugin): boolean },
    private readonly mcpLibrary: () => readonly { readonly name: string, readonly description: string }[] = () => [],
    private readonly modelLibrary: () => readonly ExpertModelChoice[] = () => []) {}
  revision(): string { return String(this.store.read().revision) }
  list(actor: CommunityAccountActor): CommunityExpertLibrary {
    this.admin(actor)
    return { experts: this.store.read().experts.map(expert => ({ ...expert, modelLabel: this.model(expert)?.label ?? null, modelUnavailable: Boolean(expert.model && !this.model(expert)), failures: this.accounts.list().flatMap(account => {
      const status = this.runtime?.status(account.username)
      const failure = status && (status.state === 'ready' || status.state === 'draining') ? status.instance.expertFailures?.find(row => row.id === expert.id) : undefined
      return failure ? [{ username: account.username, entries: failure.entries }] : []
    }) })), revision: this.revision(), plugins: (this.pluginSource?.list() ?? []).map(row => ({ packageName: row.packageName, title: row.current?.title ?? row.packageName, eligible: Boolean(!row.removing && !row.incompatible && row.stage === 'available' && row.current && this.pluginSource?.eligible(row.current)) })), mcp: this.mcpLibrary(), models: this.modelLibrary() }
  }
  async save(actor: CommunityAccountActor, input: ExpertInput, revision: string, id?: string): Promise<Expert> {
    this.admin(actor); this.fresh(revision); assertExpertInput(input)
    if (input.skills.some(name => !this.library.list().some(row => row.name === name && !row.conflict))
      || input.skillPacks.some(name => !this.packs.list().some(row => row.name === name))) throw new BusinessRuleError('invalid', 'Select current skills and skill packs from the library.', 'expert-invalid')
    const state = this.store.read(), previous = id === undefined ? undefined : state.experts.find(row => row.id === id)
    if (id !== undefined && !previous) throw new BusinessRuleError('missing', 'Expert was not found.', 'expert-not-found')
    if ((input.mcp ?? previous?.mcp ?? []).some(name => !this.mcpLibrary().some(row => row.name === name))) throw new BusinessRuleError('invalid', 'Select MCP services from the library.', 'expert-invalid')
    for (const name of input.plugins ?? previous?.plugins ?? []) {
      const row = this.pluginSource?.list().find(row => row.packageName === name)
      if (!row || row.removing || row.incompatible || row.stage !== 'available' || !row.current) throw new BusinessRuleError('invalid', 'Select available plugins from the library.', 'expert-invalid')
      if (!this.pluginSource?.eligible(row.current)) throw new BusinessRuleError('invalid', 'This plugin changes existing core entries and cannot be included in an expert.', 'expert-plugin-core-modification')
    }
    const model = input.model === undefined ? previous?.model ?? null : input.model
    if (model && !this.modelLibrary().some(row => row.providerId === model.providerId && row.name === model.name) && !(previous?.model?.providerId === model.providerId && previous.model.name === model.name)) throw new BusinessRuleError('invalid', 'Select an enabled shared model.', 'expert-invalid')
    const expert: Expert = { ...previous, ...input, id: previous?.id ?? this.newId(), revision: (previous?.revision ?? 0) + 1,
      published: previous?.published ?? false, plugins: input.plugins ?? previous?.plugins ?? [], mcp: input.mcp ?? previous?.mcp ?? [], model, examples: input.examples ?? previous?.examples ?? [] }
    this.store.write({ ...state, revision: state.revision + 1, experts: [...state.experts.filter(row => row.id !== expert.id), expert] })
    await this.changed(); return expert
  }
  group(actor: CommunityAccountActor, id: string): CommunityExpertGroup {
    this.admin(actor)
    const group = requiredCommunityGroup(this.accounts.listGroups(), id), state = this.store.read()
    return { group, experts: state.experts.map(expert => ({ id: expert.id, name: expert.name, description: expert.description, granted: group.kind === 'admin' || Boolean(state.grants[id]?.includes(expert.id)) })), revision: this.revision() }
  }
  async grant(actor: CommunityAccountActor, id: string, names: readonly string[], revision: string): Promise<void> {
    this.admin(actor); this.fresh(revision); assertOrdinaryGroup(requiredCommunityGroup(this.accounts.listGroups(), id))
    const state = this.store.read()
    if (!Array.isArray(names) || names.length > 256 || names.some(name => !state.experts.some(row => row.id === name))) throw new BusinessRuleError('invalid', 'Select experts from the library.', 'expert-invalid')
    this.store.write({ ...state, revision: state.revision + 1, grants: { ...state.grants, [id]: [...new Set(names)].sort() } })
    await this.changed()
  }
  async publish(actor: CommunityAccountActor, id: string, published: boolean, revision: string): Promise<void> {
    this.admin(actor); this.fresh(revision)
    const state = this.store.read()
    if (!state.experts.some(row => row.id === id)) throw new BusinessRuleError('missing', 'Expert was not found.', 'expert-not-found')
    const selections = Object.fromEntries(Object.entries(state.selections).map(([space, names]) => [space, published ? names : names.filter(name => name !== id)]))
    this.store.write({ ...state, revision: state.revision + 1, experts: state.experts.map(row => row.id === id ? { ...row, published } : row), selections })
    await this.changed()
  }
  market(actor: CommunityAccountActor): CommunityExpertMarket {
    const account = this.member(actor), state = this.store.read(), group = this.accounts.listGroups().find(row => row.id === account.groupId)
    const granted = (id: string) => group?.kind === 'admin' || Boolean(state.grants[account.groupId]?.includes(id))
    const status = this.runtime?.status(actor.username), snapshot = this.owned(actor.username).map(row => `${row.id}:${row.revision}`).sort()
    return { experts: state.experts.filter(row => row.published || granted(row.id)).map(row => ({ id: row.id, name: row.name, description: row.description, icon: row.icon, examples: row.examples, skills: row.skills, skillPacks: row.skillPacks, plugins: row.plugins, mcp: row.mcp, modelLabel: this.model(row)?.label ?? null,
      status: granted(row.id) ? 'granted' : state.selections[account.spaceId]?.includes(row.id) ? 'summoned' : 'available' })),
      pending: Boolean(status && (status.state === 'ready' || status.state === 'draining') && JSON.stringify([...(status.instance.expertSnapshot ?? [])].sort()) !== JSON.stringify(snapshot)) }
  }
  async select(actor: CommunityAccountActor, id: string, enabled: boolean): Promise<{ application: 'restart-required' }> {
    const account = this.member(actor), state = this.store.read(), group = this.accounts.listGroups().find(row => row.id === account.groupId)
    if (group?.kind === 'admin' || state.grants[account.groupId]?.includes(id)) throw new BusinessRuleError('forbidden', 'Group experts cannot be dismissed.', 'expert-granted')
    if (!state.experts.some(row => row.id === id && row.published)) throw new BusinessRuleError('missing', 'This expert is not available.', 'expert-unavailable')
    const names = new Set(state.selections[account.spaceId] ?? [])
    if (enabled) names.add(id); else names.delete(id)
    this.store.write({ ...state, revision: state.revision + 1, selections: { ...state.selections, [account.spaceId]: [...names].sort() } })
    await this.changed(); return { application: 'restart-required' }
  }
  start(actor: CommunityAccountActor, id: string) {
    this.member(actor)
    const expert = this.owned(actor.username).find(row => row.id === id)
    if (!expert) throw new BusinessRuleError('missing', 'This expert is not available.', 'expert-unavailable')
    const status = this.runtime?.status(actor.username)
    if (status?.state !== 'ready' || !status.instance.expertSnapshot?.includes(`${expert.id}:${expert.revision}`)) throw new BusinessRuleError('conflict', 'Restart your instance to apply expert changes.', 'expert-restart-required')
    const model = this.model(expert)
    return { agentPreset: expertPresetId(expert.id), model: model ? { provider: 'deepseek-official', model: model.id } : null }
  }
  private model(expert: Expert) { return this.modelLibrary().find(row => row.providerId === expert.model?.providerId && row.name === expert.model.name) }
  owned(username: string): readonly Expert[] {
    const account = this.accounts.get(username)
    if (!account || account.disabled) return []
    const group = this.accounts.listGroups().find(row => row.id === account.groupId)
    if (!group) return []
    const state = this.store.read()
    return state.experts.filter(row => group.kind === 'admin' || state.grants[group.id]?.includes(row.id) || row.published && state.selections[account.spaceId]?.includes(row.id))
  }
  skills(username: string) { return [...new Map(this.owned(username).flatMap(expert => this.expand(expert).skills).map(skill => [skill.name, skill])).values()] }
  plugins(username: string): readonly PreparedPlugin[] {
    const names = new Set(this.owned(username).flatMap(row => row.plugins))
    return (this.pluginSource?.list() ?? []).flatMap(row => names.has(row.packageName) && !row.removing && !row.incompatible && row.stage === 'available' && row.current && this.pluginSource?.eligible(row.current) ? [row.current] : [])
  }
  mcp(username: string): readonly string[] { return [...new Set(this.owned(username).flatMap(expert => expert.mcp))].sort() }
  plans(username: string) { return this.owned(username).map(expert => ({ expert, ...this.expand(expert), globalSkills: this.globalSkills(username) })) }
  private expand(expert: Expert) {
    const library = this.library.list(), packs = this.packs.list(), requested = new Set(expert.skills), failures: string[] = []
    const notes = []
    for (const name of expert.skillPacks) {
      const pack = packs.find(row => row.name === name)
      if (!pack) { failures.push(`skill-pack:${name}`); continue }
      for (const skill of pack.skills) requested.add(skill)
      if (pack.skills.some(name => library.some(skill => skill.name === name && !skill.conflict)) && pack.note && !pack.note.conflict) { notes.push(pack.note); requested.add(pack.note.name) }
    }
    return { requestedSkills: [...requested], skills: [...library, ...notes].filter(skill => requested.has(skill.name) && !skill.conflict), failures }
  }
  async recover(): Promise<void> {
    const state = this.store.read(), groups = new Set(this.accounts.listGroups().map(row => row.id)), ids = new Set(state.experts.map(row => row.id))
    const grants = Object.fromEntries(Object.entries(state.grants).filter(([id]) => groups.has(id)).map(([id, names]) => [id, names.filter(name => ids.has(name))]))
    const spaces = new Set(this.accounts.list().map(row => row.spaceId)), published = new Set(state.experts.filter(row => row.published).map(row => row.id))
    const selections = Object.fromEntries(Object.entries(state.selections).filter(([space]) => spaces.has(space)).map(([space, names]) => [space, names.filter(name => published.has(name))]))
    if (JSON.stringify(selections) !== JSON.stringify(state.selections) || JSON.stringify(grants) !== JSON.stringify(state.grants)) this.store.write({ ...state, revision: state.revision + 1, grants, selections })
  }
  private fresh(revision: string) { if (revision !== this.revision()) throw new BusinessRuleError('conflict', 'Expert settings changed. Review them again.', 'expert-stale') }
  private member(actor: CommunityAccountActor) {
    const account = this.accounts.get(actor.username)
    if (!account || account.disabled || account.spaceId !== actor.spaceId || account.sessionEpoch !== actor.sessionEpoch) throw new CommunityAuthenticationError('Sign in is required', 'sign-in-required')
    return account
  }
  private admin(actor: CommunityAccountActor) {
    const account = this.member(actor)
    if (!account.admin) throw new BusinessRuleError('forbidden', 'Administrator access is required', 'admin-required')
  }
}
