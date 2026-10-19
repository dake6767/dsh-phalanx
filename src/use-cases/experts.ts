import type { CommunityExpertLibrary, CommunityExpertGroup } from '../domain/admin-contract.js'
import { assertExpertInput, type Expert, type ExpertInput } from '../domain/expert.js'
import { CommunityAuthenticationError, type CommunityAccountActor } from '../domain/community-account.js'
import { BusinessRuleError } from '../domain/business-error.js'
import { assertOrdinaryGroup, requiredCommunityGroup } from '../domain/community-group.js'
import type { CommunityAccountStorePort } from '../ports/community-accounts.js'
import type { ExpertStorePort, ExpertSkillsPort, MemberExpertsPort } from '../ports/experts.js'
import type { SkillLibraryStorePort } from '../ports/skill-library.js'
import type { SkillPackStorePort } from '../ports/skill-packs.js'
import type { CommunityRuntimePort } from '../ports/community-runtime.js'

/** Expert definitions and current ownership; running preset snapshots are owned by the runtime. */
export class Experts implements ExpertSkillsPort, MemberExpertsPort {
  constructor(private readonly accounts: Pick<CommunityAccountStorePort, 'get' | 'list' | 'listGroups'>,
    private readonly store: ExpertStorePort, private readonly library: Pick<SkillLibraryStorePort, 'list'>,
    private readonly packs: Pick<SkillPackStorePort, 'list'>, private readonly newId: () => string,
    private readonly changed: () => Promise<void> = async () => {}, private readonly globalSkills: (username: string) => readonly string[] = () => [],
    private readonly runtime?: Pick<CommunityRuntimePort, 'status'>) {}
  revision(): string { return String(this.store.read().revision) }
  list(actor: CommunityAccountActor): CommunityExpertLibrary {
    this.admin(actor)
    return { experts: this.store.read().experts.map(expert => ({ ...expert, failures: this.accounts.list().flatMap(account => {
      const status = this.runtime?.status(account.username)
      const failure = status && (status.state === 'ready' || status.state === 'draining') ? status.instance.expertFailures?.find(row => row.id === expert.id) : undefined
      return failure ? [{ username: account.username, entries: failure.entries }] : []
    }) })), revision: this.revision() }
  }
  async save(actor: CommunityAccountActor, input: ExpertInput, revision: string, id?: string): Promise<Expert> {
    this.admin(actor); this.fresh(revision); assertExpertInput(input)
    if (input.skills.some(name => !this.library.list().some(row => row.name === name && !row.conflict))
      || input.skillPacks.some(name => !this.packs.list().some(row => row.name === name))) throw new BusinessRuleError('invalid', 'Select current skills and skill packs from the library.', 'expert-invalid')
    const state = this.store.read(), previous = id === undefined ? undefined : state.experts.find(row => row.id === id)
    if (id !== undefined && !previous) throw new BusinessRuleError('missing', 'Expert was not found.', 'expert-not-found')
    const expert: Expert = { ...previous, ...input, id: previous?.id ?? this.newId(), revision: (previous?.revision ?? 0) + 1,
      published: previous?.published ?? false, plugins: previous?.plugins ?? [], mcp: previous?.mcp ?? [], model: previous?.model ?? null, examples: previous?.examples ?? [] }
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
  owned(username: string): readonly Expert[] {
    const account = this.accounts.get(username)
    if (!account || account.disabled) return []
    const group = this.accounts.listGroups().find(row => row.id === account.groupId)
    if (!group) return []
    const state = this.store.read()
    return state.experts.filter(row => group.kind === 'admin' || state.grants[group.id]?.includes(row.id))
  }
  skills(username: string) { return [...new Map(this.owned(username).flatMap(expert => this.expand(expert).skills).map(skill => [skill.name, skill])).values()] }
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
    if (JSON.stringify(grants) !== JSON.stringify(state.grants)) this.store.write({ ...state, revision: state.revision + 1, grants })
  }
  private fresh(revision: string) { if (revision !== this.revision()) throw new BusinessRuleError('conflict', 'Expert settings changed. Review them again.', 'expert-stale') }
  private admin(actor: CommunityAccountActor) {
    const account = this.accounts.get(actor.username)
    if (!account || account.disabled || account.spaceId !== actor.spaceId || account.sessionEpoch !== actor.sessionEpoch) throw new CommunityAuthenticationError('Sign in is required', 'sign-in-required')
    if (!account.admin) throw new BusinessRuleError('forbidden', 'Administrator access is required', 'admin-required')
  }
}
