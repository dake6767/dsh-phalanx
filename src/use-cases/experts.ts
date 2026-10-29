import type { CommunityExpertLibrary, CommunityExpertGroup, CommunityExpertMarket, CommunityExpertImpact } from '../domain/admin-contract.js'
import { assertExpertInput, type Expert, type ExpertInput, type ExpertModelChoice } from '../domain/expert.js'
import { CommunityAuthenticationError, type CommunityAccountActor } from '../domain/community-account.js'
import { BusinessRuleError } from '../domain/business-error.js'
import { requiredCommunityGroup } from '../domain/community-group.js'
import type { CommunityAccountStorePort } from '../ports/community-accounts.js'
import type { ExpertStorePort, ExpertSnapshot, ExpertSkillsPort, ExpertMcpPort, MemberExpertsPort } from '../ports/experts.js'
import type { SkillLibraryStorePort } from '../ports/skill-library.js'
import type { SkillPackStorePort } from '../ports/skill-packs.js'
import type { CommunityRuntimePort, CommunityUserInstance } from '../ports/community-runtime.js'
import type { LibraryPlugin, PreparedPlugin } from '../domain/plugin-library.js'

/** Expert definitions and current ownership; running preset snapshots are owned by the runtime. */
export class Experts implements ExpertSkillsPort, ExpertMcpPort, MemberExpertsPort {
  constructor(
    private readonly accounts: Pick<CommunityAccountStorePort, 'get' | 'list' | 'listGroups'>,
    private readonly store: ExpertStorePort,
    private readonly library: Pick<SkillLibraryStorePort, 'list'>,
    private readonly packs: Pick<SkillPackStorePort, 'list'>,
    private readonly newId: () => string,
    private readonly changed: () => Promise<void> = async () => {},
    private readonly globalSkills: (username: string) => Promise<readonly string[]> = async () => [],
    private readonly runtime?: Pick<CommunityRuntimePort, 'status'>,
    private readonly pluginSource?: { list(): Promise<readonly LibraryPlugin[]>; eligible(plugin: PreparedPlugin): boolean },
    private readonly mcpLibrary: () => Promise<readonly { readonly name: string; readonly description: string }[]> = async () => [],
    private readonly modelLibrary: () => readonly ExpertModelChoice[] = () => [],
  ) {}
  authorizationSnapshot() {
    return this.store.view.read()
  }
  version(): string {
    return this.store.view.version()
  }
  async revision(): Promise<string> {
    return (await this.store.read()).publicRevision
  }
  async list(actor: CommunityAccountActor): Promise<CommunityExpertLibrary> {
    await this.admin(actor)
    const state = await this.store.read()
    const accounts = await this.accounts.list()
    const experts = await Promise.all(
      state.experts.map(async expert => ({
        ...expert,
        ...(await this.inspection(expert)),
        missing: await this.missing(expert),
        modelLabel: this.model(expert)?.label ?? null,
        modelUnavailable: Boolean(expert.model && !this.model(expert)),
        failures: accounts.flatMap(account => {
          const status = this.runtime?.status(account.username)
          const failure =
            status && (status.state === 'ready' || status.state === 'draining') && this.currentPreset(status.instance, expert)
              ? status.instance.expertFailures?.find(row => row.id === expert.id)
              : undefined
          return failure ? [{ username: account.username, entries: failure.entries }] : []
        }),
      })),
    )
    return {
      experts,
      revision: state.publicRevision,
      plugins: ((await this.pluginSource?.list()) ?? []).map(row => ({
        packageName: row.packageName,
        title: row.current?.title ?? row.packageName,
        eligible: Boolean(!row.removing && !row.incompatible && row.stage === 'available' && row.current && this.pluginSource?.eligible(row.current)),
      })),
      mcp: await this.mcpLibrary(),
      models: this.modelLibrary(),
    }
  }
  async save(actor: CommunityAccountActor, input: ExpertInput, revision: string, id?: string): Promise<Expert> {
    await this.admin(actor)
    const state = await this.fresh(revision)
    assertExpertInput(input)
    const previous = id === undefined ? undefined : state.experts.find(row => row.id === id)
    if (id !== undefined && !previous) throw new BusinessRuleError('missing', 'Expert was not found.', 'expert-not-found')
    const library = await this.library.list(),
      packs = await this.packs.list()
    // An unavailable saved reference can be retained while repairing another field.
    if (
      input.skills.some(name => !previous?.skills.includes(name) && !library.some(row => row.name === name && !row.conflict)) ||
      input.skillPacks.some(name => !previous?.skillPacks.includes(name) && !packs.some(row => row.name === name))
    )
      throw new BusinessRuleError('invalid', 'Select current skills and skill packs from the library.', 'expert-invalid')
    const mcpLibrary = await this.mcpLibrary()
    if ((input.mcp ?? previous?.mcp ?? []).some(name => !previous?.mcp.includes(name) && !mcpLibrary.some(row => row.name === name)))
      throw new BusinessRuleError('invalid', 'Select MCP services from the library.', 'expert-invalid')
    for (const name of input.plugins ?? previous?.plugins ?? []) {
      if (previous?.plugins.includes(name)) continue
      const row = (await this.pluginSource?.list())?.find(row => row.packageName === name)
      if (!row || row.removing || row.incompatible || row.stage !== 'available' || !row.current)
        throw new BusinessRuleError('invalid', 'Select available plugins from the library.', 'expert-invalid')
      if (!this.pluginSource?.eligible(row.current))
        throw new BusinessRuleError(
          'invalid',
          'This plugin changes existing core entries and cannot be included in an expert.',
          'expert-plugin-core-modification',
        )
    }
    const model = input.model === undefined ? (previous?.model ?? null) : input.model
    if (
      model &&
      !this.modelLibrary().some(row => row.providerId === model.providerId && row.name === model.name) &&
      !(previous?.model?.providerId === model.providerId && previous.model.name === model.name)
    )
      throw new BusinessRuleError('invalid', 'Select an enabled shared model.', 'expert-invalid')
    const expert: Expert = {
      ...previous,
      ...input,
      id: previous?.id ?? this.newId(),
      revision: (previous?.revision ?? 0) + 1,
      published: previous?.published ?? false,
      plugins: input.plugins ?? previous?.plugins ?? [],
      mcp: input.mcp ?? previous?.mcp ?? [],
      model,
      examples: input.examples ?? previous?.examples ?? [],
    }
    await this.fresh(revision)
    await this.store.update(state, { ...state, revision: state.revision + 1, experts: [...state.experts.filter(row => row.id !== expert.id), expert] })
    await this.changed()
    return expert
  }
  async group(actor: CommunityAccountActor, id: string): Promise<CommunityExpertGroup> {
    await this.admin(actor)
    const group = requiredCommunityGroup(await this.accounts.listGroups(), id),
      state = await this.store.read()
    return {
      group,
      experts: state.experts.map(expert => ({
        id: expert.id,
        name: expert.name,
        description: expert.description,
        granted: Boolean(state.grants[id]?.includes(expert.id)),
      })),
      revision: state.publicRevision,
    }
  }
  async grant(actor: CommunityAccountActor, id: string, names: readonly string[], revision: string): Promise<void> {
    await this.admin(actor)
    requiredCommunityGroup(await this.accounts.listGroups(), id)
    const state = await this.fresh(revision)
    if (!Array.isArray(names) || names.length > 256 || names.some(name => !state.experts.some(row => row.id === name)))
      throw new BusinessRuleError('invalid', 'Select experts from the library.', 'expert-invalid')
    await this.store.update(state, { ...state, revision: state.revision + 1, grants: { ...state.grants, [id]: [...new Set(names)].sort() } })
    await this.changed()
  }
  async publish(actor: CommunityAccountActor, id: string, published: boolean, revision: string): Promise<void> {
    await this.admin(actor)
    const state = await this.fresh(revision)
    if (!state.experts.some(row => row.id === id)) throw new BusinessRuleError('missing', 'Expert was not found.', 'expert-not-found')
    const selections = Object.fromEntries(
      Object.entries(state.selections).map(([space, names]) => [space, published ? names : names.filter(name => name !== id)]),
    )
    await this.store.update(state, {
      ...state,
      revision: state.revision + 1,
      experts: state.experts.map(row => (row.id === id ? { ...row, published } : row)),
      selections,
    })
    await this.changed()
  }
  async market(actor: CommunityAccountActor): Promise<CommunityExpertMarket> {
    const account = await this.member(actor),
      state = await this.store.read()
    const granted = (id: string) => Boolean(state.grants[account.groupId]?.includes(id))
    const status = this.runtime?.status(actor.username),
      snapshot = (await this.owned(actor.username)).map(row => `${row.id}:${row.revision}`).sort()
    return {
      experts: await Promise.all(
        state.experts
          .filter(row => row.published || granted(row.id))
          .map(async row => ({
            id: row.id,
            name: row.name,
            description: row.description,
            icon: row.icon,
            examples: row.examples,
            skills: row.skills,
            skillPacks: row.skillPacks,
            plugins: row.plugins,
            mcp: row.mcp,
            modelLabel: this.model(row)?.label ?? null,
            partial:
              (await this.missing(row)).length > 0 ||
              Boolean(
                status &&
                (status.state === 'ready' || status.state === 'draining') &&
                this.currentPreset(status.instance, row) &&
                status.instance.expertFailures?.some(failure => failure.id === row.id && failure.entries.length > 0),
              ),
            ...(this.checking(status, row) ? { checking: true } : {}),
            status: granted(row.id) ? 'granted' : state.selections[account.spaceId]?.includes(row.id) ? 'summoned' : 'available',
          })),
      ),
      pending: Boolean(
        status &&
        (status.state === 'ready' || status.state === 'draining') &&
        JSON.stringify([...(status.instance.expertSnapshot ?? [])].sort()) !== JSON.stringify(snapshot),
      ),
    }
  }
  async select(actor: CommunityAccountActor, id: string, enabled: boolean): Promise<{ application: 'restart-required' }> {
    const account = await this.member(actor),
      state = await this.store.read()
    if (state.grants[account.groupId]?.includes(id)) throw new BusinessRuleError('forbidden', 'Group experts cannot be dismissed.', 'expert-granted')
    if (!state.experts.some(row => row.id === id && row.published))
      throw new BusinessRuleError('missing', 'This expert is not available.', 'expert-unavailable')
    const names = new Set(state.selections[account.spaceId] ?? [])
    if (enabled) names.add(id)
    else names.delete(id)
    await this.store.update(state, { ...state, revision: state.revision + 1, selections: { ...state.selections, [account.spaceId]: [...names].sort() } })
    await this.changed()
    return { application: 'restart-required' }
  }
  async start(actor: CommunityAccountActor, id: string) {
    await this.member(actor)
    const expert = (await this.owned(actor.username)).find(row => row.id === id)
    if (!expert) throw new BusinessRuleError('missing', 'This expert is not available.', 'expert-unavailable')
    const status = this.runtime?.status(actor.username)
    if (status?.state !== 'ready' || !this.currentPreset(status.instance, expert))
      throw new BusinessRuleError('conflict', 'Restart your instance to apply expert changes.', 'expert-restart-required')
    const model = this.model(expert)
    return { expertId: expert.id, modelId: model?.id ?? null }
  }
  private checking(status: ReturnType<CommunityRuntimePort['status']> | undefined, expert: Expert): boolean {
    return Boolean(
      status &&
      (status.state === 'ready' || status.state === 'draining') &&
      status.instance.inspection === 'checking' &&
      this.currentPreset(status.instance, expert),
    )
  }
  private async inspection(expert: Expert): Promise<{ checking?: readonly string[] }> {
    const checking = (await this.accounts.list())
      .filter(account => this.checking(this.runtime?.status(account.username), expert))
      .map(account => account.username)
    return checking.length ? { checking } : {}
  }
  private currentPreset(instance: Pick<CommunityUserInstance, 'expertSnapshot'>, expert: Expert): boolean {
    return instance.expertSnapshot?.includes(`${expert.id}:${expert.revision}`) ?? false
  }
  private model(expert: Expert) {
    return this.modelLibrary().find(row => row.providerId === expert.model?.providerId && row.name === expert.model.name)
  }
  async impact(actor: CommunityAccountActor, id: string): Promise<CommunityExpertImpact> {
    await this.admin(actor)
    return this.removalImpact(await this.store.read(), id)
  }
  private async removalImpact(state: ExpertSnapshot, id: string): Promise<CommunityExpertImpact> {
    const expert = state.experts.find(row => row.id === id)
    if (!expert) throw new BusinessRuleError('missing', 'Expert was not found.', 'expert-not-found')
    const ownership = await Promise.all(
      (await this.accounts.list()).map(async account => ({
        username: account.username,
        owned: (await this.owned(account.username)).some(row => row.id === id),
      })),
    )
    const members = ownership
      .filter(row => row.owned)
      .map(row => row.username)
      .sort()
    const groups = (await this.accounts.listGroups()).filter(group => state.grants[group.id]?.includes(id)).map(group => ({ id: group.id, name: group.name }))
    return { expert: { id, name: expert.name }, members, groups, revision: JSON.stringify([state.publicRevision, members, groups]) }
  }
  async remove(actor: CommunityAccountActor, id: string, revision: string): Promise<void> {
    await this.admin(actor)
    const state = await this.store.read()
    if (revision !== (await this.removalImpact(state, id)).revision)
      throw new BusinessRuleError('conflict', 'Expert ownership changed. Review the deletion impact again.', 'expert-stale')
    const without = (rows: Readonly<Record<string, readonly string[]>>) =>
      Object.fromEntries(Object.entries(rows).map(([key, names]) => [key, names.filter(name => name !== id)]))
    await this.store.update(state, {
      ...state,
      revision: state.revision + 1,
      experts: state.experts.filter(row => row.id !== id),
      grants: without(state.grants),
      selections: without(state.selections),
    })
    await this.changed()
  }
  private async missing(expert: Expert): Promise<string[]> {
    const library = await this.library.list(),
      packs = await this.packs.list()
    const failures = expert.skills.filter(name => !library.some(row => row.name === name && !row.conflict)).map(name => `skill:${name}`)
    for (const name of expert.skillPacks) {
      const pack = packs.find(row => row.name === name)
      if (!pack) failures.push(`skill-pack:${name}`)
      else {
        for (const skill of pack.skills) if (!library.some(row => row.name === skill && !row.conflict)) failures.push(`skill:${skill}`)
        if (pack.note?.conflict) failures.push(`skill-pack:${name}`)
      }
    }
    for (const name of expert.plugins) {
      const row = (await this.pluginSource?.list())?.find(row => row.packageName === name)
      if (!row || row.removing || row.incompatible || row.stage !== 'available' || !row.current || !this.pluginSource?.eligible(row.current))
        failures.push(`plugin:${name}`)
    }
    const mcpLibrary = await this.mcpLibrary()
    for (const name of expert.mcp) if (!mcpLibrary.some(row => row.name === name)) failures.push(`mcp:${name}`)
    return [...new Set(failures)].sort()
  }
  async owned(username: string): Promise<readonly Expert[]> {
    const account = await this.accounts.get(username)
    if (!account || account.disabled) return []
    const group = (await this.accounts.listGroups()).find(row => row.id === account.groupId)
    if (!group) return []
    const state = await this.store.read()
    return state.experts.filter(row => state.grants[group.id]?.includes(row.id) || (row.published && state.selections[account.spaceId]?.includes(row.id)))
  }
  async skills(username: string) {
    const [owned, library, packs] = await Promise.all([this.owned(username), this.library.list(), this.packs.list()])
    return [...new Map(owned.flatMap(expert => this.expand(expert, library, packs).skills).map(skill => [skill.name, skill])).values()]
  }
  async plugins(username: string): Promise<readonly PreparedPlugin[]> {
    const names = new Set((await this.owned(username)).flatMap(row => row.plugins))
    return ((await this.pluginSource?.list()) ?? []).flatMap(row =>
      names.has(row.packageName) && !row.removing && !row.incompatible && row.stage === 'available' && row.current && this.pluginSource?.eligible(row.current)
        ? [row.current]
        : [],
    )
  }
  async mcp(username: string): Promise<readonly string[]> {
    return [...new Set((await this.owned(username)).flatMap(expert => expert.mcp))].sort()
  }
  async plans(username: string) {
    const [owned, globalSkills, library, packs] = await Promise.all([this.owned(username), this.globalSkills(username), this.library.list(), this.packs.list()])
    return owned.map(expert => ({ expert, ...this.expand(expert, library, packs), globalSkills }))
  }
  private expand(
    expert: Expert,
    library: readonly import('../domain/skill-library.js').LibrarySkill[],
    packs: readonly import('../domain/skill-pack.js').SkillPack[],
  ) {
    const requested = new Set(expert.skills),
      failures: string[] = []
    const notes = []
    for (const name of expert.skillPacks) {
      const pack = packs.find(row => row.name === name)
      if (!pack) {
        failures.push(`skill-pack:${name}`)
        continue
      }
      for (const skill of pack.skills) requested.add(skill)
      if (pack.skills.some(name => library.some(skill => skill.name === name && !skill.conflict)) && pack.note && !pack.note.conflict) {
        notes.push(pack.note)
        requested.add(pack.note.name)
      }
    }
    return { requestedSkills: [...requested], skills: [...library, ...notes].filter(skill => requested.has(skill.name) && !skill.conflict), failures }
  }
  async recover(): Promise<void> {
    const [accounts, accountGroups] = await Promise.all([this.accounts.list(), this.accounts.listGroups()])
    const state = await this.store.read(),
      groups = new Set(accountGroups.map(row => row.id)),
      ids = new Set(state.experts.map(row => row.id))
    const grants = Object.fromEntries(
      Object.entries(state.grants)
        .filter(([id]) => groups.has(id))
        .map(([id, names]) => [id, names.filter(name => ids.has(name))]),
    )
    const spaces = new Set(accounts.map(row => row.spaceId)),
      published = new Set(state.experts.filter(row => row.published).map(row => row.id))
    const selections = Object.fromEntries(
      Object.entries(state.selections)
        .filter(([space]) => spaces.has(space))
        .map(([space, names]) => [space, names.filter(name => published.has(name))]),
    )
    if (JSON.stringify(selections) !== JSON.stringify(state.selections) || JSON.stringify(grants) !== JSON.stringify(state.grants))
      await this.store.update(state, { ...state, revision: state.revision + 1, grants, selections })
  }
  private async fresh(revision: string): Promise<ExpertSnapshot> {
    const state = await this.store.read()
    if (revision !== state.publicRevision) throw new BusinessRuleError('conflict', 'Expert settings changed. Review them again.', 'expert-stale')
    return state
  }
  private async member(actor: CommunityAccountActor) {
    const account = await this.accounts.get(actor.username)
    if (!account || account.disabled || account.spaceId !== actor.spaceId || account.sessionEpoch !== actor.sessionEpoch)
      throw new CommunityAuthenticationError('Sign in is required', 'sign-in-required')
    return account
  }
  private async admin(actor: CommunityAccountActor) {
    const account = await this.member(actor)
    if (!account.admin) throw new BusinessRuleError('forbidden', 'Administrator access is required', 'admin-required')
  }
}
