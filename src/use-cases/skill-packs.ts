import { BusinessRuleError } from '../domain/business-error.js'
import { CommunityAuthenticationError, type CommunityAccountActor } from '../domain/community-account.js'
import type { CommunitySkillPackInput, CommunitySkillPackView, CommunitySkillPackDetail, CommunityMarketPack } from '../domain/admin-contract.js'
import type { SkillPack } from '../domain/skill-pack.js'
import type { CommunityAccountStorePort } from '../ports/community-accounts.js'
import type { SkillLibraryStorePort } from '../ports/skill-library.js'
import type { SkillPackState, SkillNotePort } from '../ports/skill-packs.js'
import type { SkillAssignmentsPort } from '../ports/member-skills.js'
import type { Clock } from '../ports/clock.js'
import type { SkillLibrary } from './skill-library.js'

/** Pack mutations share the library's queue, artifact lifetime and distribution boundary. */
export class SkillPacks {
  constructor(private readonly accounts: Pick<CommunityAccountStorePort, 'get' | 'list' | 'listGroups'>,
    private readonly library: SkillLibraryStorePort, private readonly packs: SkillPackState,
    private readonly direct: Pick<SkillAssignmentsPort, 'get'>, private readonly queue: Pick<SkillLibrary, 'mutate'>,
    private readonly notes: SkillNotePort, private readonly clock: Clock, private readonly bundled: readonly string[] = [], private readonly selections?: Pick<SkillAssignmentsPort, 'get'>) {}
  list(actor: CommunityAccountActor): readonly CommunitySkillPackView[] { this.admin(actor); return this.packs.store.list().map(pack => this.view(actor, pack)) }
  revision(actor: CommunityAccountActor): string {
    this.admin(actor)
    return JSON.stringify([this.packs.store.list(), this.library.list(), this.accounts.listGroups().map(group => [group, this.direct.get(group.id), this.packs.grants.get(group.id)]), this.accounts.list().map(account => [account.spaceId, account.groupId, this.packs.selections.get(account.spaceId), this.selections?.get(account.spaceId)])])
  }
  detail(actor: CommunityAccountActor, name: string): CommunitySkillPackDetail {
    this.admin(actor); const pack = this.required(name), deleting: string[] = [], retained: { name: string, reasons: ('other-pack' | 'direct-grant')[] }[] = []
    for (const child of pack.skills) {
      const reasons: ('other-pack' | 'direct-grant')[] = []
      if (this.packs.store.list().some(other => other.name !== name && other.skills.includes(child))) reasons.push('other-pack')
      if (this.accounts.listGroups().some(group => this.direct.get(group.id).includes(child))) reasons.push('direct-grant')
      if (reasons.length) retained.push({ name: child, reasons }); else deleting.push(child)
    }
    const groups = this.accounts.listGroups().filter(group => group.kind === 'admin' || this.packs.grants.get(group.id).includes(name)).map(({ id, name }) => ({ id, name }))
    const selectedMembers = this.accounts.list().filter(account => this.packs.selections.get(account.spaceId).includes(name)).length
    const selectedMembersWithSkills = this.accounts.list().filter(account => this.packs.selections.get(account.spaceId).includes(name) || this.selections?.get(account.spaceId).some(skill => deleting.includes(skill))).length
    return { ...this.view(actor, pack), removal: { deleting, retained, groups, selectedMembers, selectedMembersWithSkills } }
  }
  save(actor: CommunityAccountActor, input: CommunitySkillPackInput, revision: string, previousName = input.name): Promise<CommunitySkillPackView> {
    return this.queue.mutate(async () => {
      this.admin(actor); this.fresh(actor, input.name, revision)
      this.assertNotSuite(previousName)
      if (previousName !== input.name) {
        this.required(previousName)
        if (this.packs.store.list().some(pack => pack.name === input.name)) throw new BusinessRuleError('conflict', 'The orchestration skill name is already in use.', 'skill-pack-name-conflict')
      }
      if (this.packInputInvalid(input) || input.skills.length > 256 || input.skills.some(name => !this.library.list().some(skill => skill.name === name && (!skill.conflict || this.packs.store.list().find(pack => pack.name === previousName)?.skills.includes(name)))))
        throw new BusinessRuleError('invalid', 'Select distinct library skills and enter a name and description.', 'skill-pack-invalid')
      if (input.instructions.trim() && (this.bundled.includes(input.name) || this.library.list().some(skill => skill.name === input.name)))
        throw new BusinessRuleError('conflict', 'The orchestration skill name is already in use.', 'skill-pack-name-conflict')
      const note = input.instructions.trim() ? await this.notes.createNote(input.name, input.description, input.instructions) : undefined
      this.admin(actor)
      const pack: SkillPack = { ...input, ...(previousName !== input.name ? { renamedFrom: previousName } : {}), ...(note ? { note: { name: note.name, description: note.description, hash: note.hash, importedAt: this.clock.now(), published: false } } : {}) }
      this.packs.store.save(pack)
    }).then(() => this.view(actor, this.required(input.name)))
  }
  remove(actor: CommunityAccountActor, name: string, deleteSkills: boolean, revision: string): Promise<void> {
    return this.queue.mutate(async () => {
      this.admin(actor); this.fresh(actor, name, revision)
      this.assertNotSuite(name)
      const deleting = deleteSkills ? this.detail(actor, name).removal.deleting : []
      this.packs.store.save({ ...this.required(name), removing: deleting })
    })
  }
  /** Suite installs commit packs through the same queue, retention and distribution boundary. */
  commitSuitePack(origin: string, input: { name: string, description: string, skills: readonly string[], instructions: string }): Promise<void> {
    return this.queue.mutate(async () => {
      if (this.packInputInvalid(input) || this.packs.store.list().some(pack => pack.name === input.name && pack.suiteOrigin !== origin)) throw new BusinessRuleError('invalid', 'Review the skill pack name and selected skills.', 'skill-pack-invalid')
      if (input.instructions.trim() && (this.bundled.includes(input.name) || this.library.list().some(skill => skill.name === input.name && skill.suiteOrigin !== origin))) throw new BusinessRuleError('conflict', 'The orchestration skill name is already in use.', 'skill-pack-name-conflict')
      const note = input.instructions.trim() ? await this.notes.createNote(input.name, input.description, input.instructions) : undefined
      this.packs.store.save({ name: input.name, description: input.description, skills: [...input.skills], instructions: input.instructions, published: false, suiteOrigin: origin,
        ...(note ? { note: { name: note.name, description: note.description, hash: note.hash, importedAt: this.clock.now(), published: false } } : {}) })
    })
  }
  /** Detaching keeps grants, selections, publication and the orchestration note. */
  detachSuitePack(origin: string, name: string): Promise<void> {
    return this.queue.mutate(async () => {
      const pack = this.packs.store.list().find(row => row.name === name && row.suiteOrigin === origin)
      if (!pack) return
      const { suiteOrigin, ...detached } = pack; void suiteOrigin
      this.packs.store.save(detached)
    })
  }
  removeSuitePack(origin: string): Promise<void> {
    return this.queue.mutate(async () => {
      for (const pack of this.packs.store.list().filter(row => row.suiteOrigin === origin)) this.packs.store.remove(pack.name)
    })
  }
  /** Applies the install wizard's optional publication and group grants; publication and grants are ordinary state. */
  applySuiteOptions(name: string, options: { readonly publish?: boolean, readonly groups?: readonly string[] }): Promise<void> {
    return this.queue.mutate(async () => {
      const pack = this.packs.store.list().find(row => row.name === name)
      if (!pack) return
      if (options.publish && !pack.published) this.packs.store.save({ ...pack, published: true })
      const groups = new Set(this.accounts.listGroups().map(group => group.id))
      for (const id of options.groups ?? []) if (groups.has(id)) this.packs.grants.set(id, [...new Set([...this.packs.grants.get(id), name])])
    })
  }
  suiteImpact(name: string): { groups: readonly { id: string, name: string }[], published: boolean, selectedMembers: number } | undefined {
    const pack = this.packs.store.list().find(row => row.name === name)
    if (!pack) return undefined
    return { groups: this.accounts.listGroups().filter(group => group.kind === 'admin' || this.packs.grants.get(group.id).includes(name)).map(({ id, name }) => ({ id, name })),
      published: pack.published, selectedMembers: this.accounts.list().filter(account => this.packs.selections.get(account.spaceId).includes(name)).length }
  }
  /** Manual packs that reference a skill block suite uninstalls until the reference is removed. */
  manualPacksContaining(name: string): readonly string[] {
    return this.packs.store.list().filter(pack => pack.suiteOrigin === undefined && pack.skills.includes(name)).map(pack => pack.name)
  }
  private packInputInvalid(input: { name: string, description: string, skills: readonly string[], instructions: string }): boolean {
    return !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(input.name) || input.name.length > 64 || !input.description.trim() || input.description.length > 4096
      || input.instructions.length > 100_000 || new Set(input.skills).size !== input.skills.length || input.skills.length > 256
      || input.skills.some(name => !this.library.list().some(skill => skill.name === name))
  }
  private assertNotSuite(name: string): void {
    const pack = this.packs.store.list().find(row => row.name === name)
    if (pack?.suiteOrigin) throw new BusinessRuleError('forbidden', 'Suite catalog entries are read-only. Uninstall the suite or detach the entry first.', 'suite-entry-locked')
  }
  market(actor: CommunityAccountActor): readonly CommunityMarketPack[] {
    const account = this.current(actor), group = this.accounts.listGroups().find(group => group.id === account.groupId)
    if (!group) return []
    return this.packs.store.list().flatMap(pack => {
      const skills = pack.skills.filter(name => this.library.list().some(skill => skill.name === name && !skill.conflict))
      const source = group.kind === 'admin' || this.packs.grants.get(group.id).includes(pack.name) ? 'managed' as const
        : pack.published && this.packs.selections.get(account.spaceId).includes(pack.name) ? 'selected' as const : null
      return skills.length && (pack.published || source) ? [{ name: pack.name, description: pack.description, instructions: pack.instructions, skills, source }] : []
    })
  }
  select(actor: CommunityAccountActor, name: string, selected: boolean): Promise<void> {
    return this.queue.mutate(async () => {
      const account = this.current(actor), pack = this.required(name), view = this.market(actor).find(row => row.name === name)
      if (!pack.published || !view || view.source === 'managed') throw new BusinessRuleError('conflict', 'Skill selection is unavailable.', 'skill-unavailable')
      const values = this.packs.selections.get(account.spaceId).filter(value => value !== name)
      this.packs.selections.set(account.spaceId, selected ? [...values, name] : values)
    })
  }
  private view(actor: CommunityAccountActor, pack: SkillPack): CommunitySkillPackView {
    return { name: pack.name, description: pack.description, skills: pack.skills, instructions: pack.instructions, published: pack.published,
      ...(pack.suiteOrigin !== undefined ? { suiteOrigin: pack.suiteOrigin } : {}),
      empty: !pack.skills.length, conflict: !!pack.note?.conflict, revision: this.revision(actor) }
  }
  private required(name: string): SkillPack {
    const pack = this.packs.store.list().find(pack => pack.name === name)
    if (!pack) throw new BusinessRuleError('missing', 'Skill pack was not found.', 'skill-unavailable')
    return pack
  }
  private fresh(actor: CommunityAccountActor, name: string, revision: string) {
    if (this.revision(actor) !== revision) throw new BusinessRuleError('conflict', 'Review the skill again before confirming.', 'skill-preview-changed')
  }
  private current(actor: CommunityAccountActor) {
    const account = this.accounts.get(actor.username)
    if (!account || account.disabled || account.spaceId !== actor.spaceId || account.sessionEpoch !== actor.sessionEpoch) throw new CommunityAuthenticationError('Sign in is required', 'sign-in-required')
    return account
  }
  private admin(actor: CommunityAccountActor) { if (!this.current(actor).admin) throw new BusinessRuleError('forbidden', 'Administrator access is required', 'admin-required') }
}
