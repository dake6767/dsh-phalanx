import { BusinessRuleError } from '../domain/business-error.js'
import { CommunityAuthenticationError, type CommunityAccountActor } from '../domain/community-account.js'
import type { CommunitySkillPackInput, CommunitySkillPackView, CommunitySkillPackDetail, CommunityMarketPack } from '../domain/admin-contract.js'
import type { ExpertReferencesPort } from '../ports/experts.js'
import type { ExpertReferenceTarget } from '../domain/expert-reference.js'
import type { SkillPack } from '../domain/skill-pack.js'
import type { CommunityAccountStorePort } from '../ports/community-accounts.js'
import type { SkillLibraryStorePort } from '../ports/skill-library.js'
import type { SkillPackState, SkillNotePort } from '../ports/skill-packs.js'
import type { SkillAssignmentsPort } from '../ports/member-skills.js'
import type { Clock } from '../ports/clock.js'
import type { SkillLibrary } from './skill-library.js'

/** Pack mutations share the library's queue, artifact lifetime and distribution boundary. */
export class SkillPacks {
  constructor(
    private readonly accounts: Pick<CommunityAccountStorePort, 'get' | 'list' | 'listGroups'>,
    private readonly library: SkillLibraryStorePort,
    private readonly packs: SkillPackState,
    private readonly direct: Pick<SkillAssignmentsPort, 'get'>,
    private readonly queue: Pick<SkillLibrary, 'mutate' | 'transaction'>,
    private readonly notes: SkillNotePort,
    private readonly clock: Clock,
    private readonly bundled: readonly string[] = [],
    private readonly selections?: Pick<SkillAssignmentsPort, 'get'>,
    private readonly expertReferences?: ExpertReferencesPort,
  ) {}
  async list(actor: CommunityAccountActor): Promise<readonly CommunitySkillPackView[]> {
    await this.admin(actor)
    return Promise.all((await this.packs.store.list()).map(pack => this.view(actor, pack)))
  }
  async revision(actor: CommunityAccountActor): Promise<string> {
    await this.admin(actor)
    return JSON.stringify([
      await this.packs.store.list(),
      await this.library.list(),
      (
        await this.expertReferences?.impact([
          ...(await this.packs.store.list()).map(row => ({ kind: 'pack' as const, name: row.name })),
          ...(await this.library.list()).map(row => ({ kind: 'skill' as const, name: row.name })),
        ])
      )?.revision,
      await Promise.all((await this.accounts.listGroups()).map(async group => [group, await this.direct.get(group.id), await this.packs.grants.get(group.id)])),
      await Promise.all(
        (await this.accounts.list()).map(async account => [
          account.spaceId,
          account.groupId,
          await this.packs.selections.get(account.spaceId),
          await this.selections?.get(account.spaceId),
        ]),
      ),
    ])
  }
  async detail(actor: CommunityAccountActor, name: string): Promise<CommunitySkillPackDetail> {
    await this.admin(actor)
    const revision = await this.revision(actor),
      pack = await this.required(name),
      packs = await this.packs.store.list(),
      deleting: string[] = [],
      retained: { name: string; reasons: ('other-pack' | 'direct-grant')[] }[] = []
    const groupFacts = await Promise.all(
      (await this.accounts.listGroups()).map(async group => ({
        group,
        direct: await this.direct.get(group.id),
        granted: await this.packs.grants.get(group.id),
      })),
    )
    const accountFacts = await Promise.all(
      (await this.accounts.list()).map(async account => ({
        selected: await this.packs.selections.get(account.spaceId),
        direct: (await this.selections?.get(account.spaceId)) ?? [],
      })),
    )
    for (const child of pack.skills) {
      const reasons: ('other-pack' | 'direct-grant')[] = []
      if (packs.some(other => other.name !== name && other.skills.includes(child))) reasons.push('other-pack')
      if (groupFacts.some(row => row.direct.includes(child))) reasons.push('direct-grant')
      if (reasons.length) retained.push({ name: child, reasons })
      else deleting.push(child)
    }
    const groups = groupFacts.filter(row => row.granted.includes(name)).map(({ group: { id, name } }) => ({ id, name }))
    const selectedMembers = accountFacts.filter(row => row.selected.includes(name)).length
    const selectedMembersWithSkills = accountFacts.filter(row => row.selected.includes(name) || row.direct.some(skill => deleting.includes(skill))).length
    const experts = (await this.expertReferences?.impact([{ kind: 'pack', name }]))?.experts ?? [],
      expertsWithSkills =
        (await this.expertReferences?.impact([{ kind: 'pack', name }, ...deleting.map(name => ({ kind: 'skill' as const, name }))]))?.experts ?? []
    return {
      ...(await this.view(actor, pack, revision)),
      removal: { deleting, retained, groups, selectedMembers, selectedMembersWithSkills, experts, expertsWithSkills },
    }
  }
  save(actor: CommunityAccountActor, input: CommunitySkillPackInput, revision: string, previousName = input.name): Promise<CommunitySkillPackView> {
    return this.queue
      .mutate(async () => {
        await this.admin(actor)
        await this.fresh(actor, input.name, revision)
        await this.assertNotSuite(previousName)
        const library = await this.library.list(),
          packs = await this.packs.store.list()
        if (previousName !== input.name) {
          await this.required(previousName)
          if (packs.some(pack => pack.name === input.name))
            throw new BusinessRuleError('conflict', 'The orchestration skill name is already in use.', 'skill-pack-name-conflict')
        }
        if (
          (await this.packInputInvalid(input)) ||
          input.skills.length > 256 ||
          input.skills.some(
            name => !library.some(skill => skill.name === name && (!skill.conflict || packs.find(pack => pack.name === previousName)?.skills.includes(name))),
          )
        )
          throw new BusinessRuleError('invalid', 'Select distinct library skills and enter a name and description.', 'skill-pack-invalid')
        if (input.instructions.trim() && (this.bundled.includes(input.name) || library.some(skill => skill.name === input.name)))
          throw new BusinessRuleError('conflict', 'The orchestration skill name is already in use.', 'skill-pack-name-conflict')
        const note = input.instructions.trim() ? await this.notes.createNote(input.name, input.description, input.instructions) : undefined
        await this.admin(actor)
        const pack: SkillPack = {
          ...input,
          ...(packs.find(row => row.name === previousName)?.rowRevision !== undefined
            ? { rowRevision: packs.find(row => row.name === previousName)!.rowRevision }
            : {}),
          ...(note ? { note: { name: note.name, description: note.description, hash: note.hash, importedAt: this.clock.now(), published: false } } : {}),
        }
        await this.queue.transaction(async repositories => {
          if (previousName !== input.name) {
            if (!repositories.packs.store.rename) throw new BusinessRuleError('conflict', 'Skill pack rename is unavailable.', 'skill-unavailable')
            await repositories.expertReferences?.touch([{ kind: 'pack', name: previousName }])
            await repositories.packs.store.rename(previousName, pack)
          } else await repositories.packs.store.save(pack)
        })
      })
      .then(async () => await this.view(actor, await this.required(input.name)))
  }
  remove(actor: CommunityAccountActor, name: string, deleteSkills: boolean, revision: string): Promise<void> {
    return this.queue.mutate(async () => {
      await this.admin(actor)
      await this.fresh(actor, name, revision)
      await this.assertNotSuite(name)
      const deleting = deleteSkills ? (await this.detail(actor, name)).removal.deleting : [],
        pack = await this.required(name),
        skills = (await this.library.list()).filter(row => deleting.includes(row.name)),
        targets: ExpertReferenceTarget[] = [{ kind: 'pack', name }, ...deleting.map(name => ({ kind: 'skill' as const, name }))],
        impact = await this.expertReferences?.impact(targets)
      await this.fresh(actor, name, revision)
      await this.queue.transaction(async repositories => {
        if (impact) {
          if (!repositories.expertReferences) throw Error('Expert reference retirement requires a shared transaction')
          await repositories.expertReferences.detach(targets, impact.revision)
        }
        await repositories.packs.store.remove(name, pack.rowRevision)
        for (const skill of skills) await repositories.library.remove(skill.name, skill.rowRevision)
      })
    })
  }
  /** Suite installs commit packs through the same queue, retention and distribution boundary. */
  commitSuitePack(origin: string, input: { name: string; description: string; skills: readonly string[]; instructions: string }): Promise<void> {
    return this.queue.mutate(async () => {
      if ((await this.packInputInvalid(input)) || (await this.packs.store.list()).some(pack => pack.name === input.name && pack.suiteOrigin !== origin))
        throw new BusinessRuleError('invalid', 'Review the skill pack name and selected skills.', 'skill-pack-invalid')
      if (
        input.instructions.trim() &&
        (this.bundled.includes(input.name) || (await this.library.list()).some(skill => skill.name === input.name && skill.suiteOrigin !== origin))
      )
        throw new BusinessRuleError('conflict', 'The orchestration skill name is already in use.', 'skill-pack-name-conflict')
      const note = input.instructions.trim() ? await this.notes.createNote(input.name, input.description, input.instructions) : undefined
      await this.packs.store.save({
        name: input.name,
        description: input.description,
        skills: [...input.skills],
        instructions: input.instructions,
        published: false,
        suiteOrigin: origin,
        ...(note ? { note: { name: note.name, description: note.description, hash: note.hash, importedAt: this.clock.now(), published: false } } : {}),
      })
    })
  }
  /** The pack this suite owns, as an update finds it. */
  async suitePack(origin: string): Promise<SkillPack | undefined> {
    return structuredClone((await this.packs.store.list()).find(row => row.suiteOrigin === origin))
  }
  /** Moves the suite pack to the new version's members and note; grants, selections and publication stay with the name.
   * Skills detached from the suite stay members so an update does not withdraw them. */
  updateSuitePack(
    origin: string,
    input: { name: string; description: string; skills: readonly string[]; instructions: string },
    detached: readonly string[],
  ): Promise<void> {
    return this.queue.mutate(async () => {
      const current = (await this.packs.store.list()).find(row => row.name === input.name && row.suiteOrigin === origin)
      if (!current || (await this.packInputInvalid(input)))
        throw new BusinessRuleError('invalid', 'Review the skill pack name and selected skills.', 'skill-pack-invalid')
      const note = input.instructions.trim()
        ? input.instructions === current.instructions && current.note
          ? current.note
          : await this.notes.createNote(input.name, input.description, input.instructions)
        : undefined
      const { note: previous, ...rest } = current
      void previous
      const skills = [...input.skills, ...current.skills.filter(name => detached.includes(name) && !input.skills.includes(name))]
      await this.packs.store.save({
        ...rest,
        description: input.description,
        skills,
        instructions: input.instructions,
        ...(note
          ? {
              note:
                'importedAt' in note
                  ? note
                  : {
                      name: note.name,
                      description: note.description,
                      hash: note.hash,
                      importedAt: this.clock.now(),
                      published: current.note?.published ?? false,
                    },
            }
          : {}),
      })
    })
  }
  /** Puts the suite pack back as an update found it, while the suite still owns it. */
  restoreSuitePack(origin: string, pack: SkillPack): Promise<void> {
    return this.queue.mutate(async () => {
      const current = (await this.packs.store.list()).find(row => row.name === pack.name)
      if (current?.suiteOrigin === origin)
        await this.packs.store.save({ ...pack, ...(current.rowRevision !== undefined ? { rowRevision: current.rowRevision } : {}) })
    })
  }
  /** Pack names already used by a pack this suite does not own; installing would fail at its last step. */
  async suitePackConflicts(origin: string, names: readonly string[]): Promise<readonly string[]> {
    const packs = await this.packs.store.list()
    return names.filter(name => packs.some(pack => pack.name === name && pack.suiteOrigin !== origin))
  }
  /** Detaching keeps grants, selections, publication and the orchestration note. */
  detachSuitePack(origin: string, name: string): Promise<void> {
    return this.queue.mutate(async () => {
      const pack = (await this.packs.store.list()).find(row => row.name === name && row.suiteOrigin === origin)
      if (!pack) return
      const { suiteOrigin, ...detached } = pack
      void suiteOrigin
      await this.packs.store.save(detached)
    })
  }
  removeSuitePack(origin: string): Promise<void> {
    return this.queue.mutate(async () => {
      await this.queue.transaction(async repositories => {
        const packs = (await repositories.packs.store.list()).filter(row => row.suiteOrigin === origin)
        await repositories.expertReferences?.detach(packs.map(row => ({ kind: 'pack', name: row.name })))
        for (const pack of packs) await repositories.packs.store.remove(pack.name, pack.rowRevision)
      })
    })
  }
  /** Applies the install wizard's optional publication and group grants; publication and grants are ordinary state. */
  applySuiteOptions(name: string, options: { readonly publish?: boolean; readonly groups?: readonly string[] }): Promise<void> {
    return this.queue.mutate(async () => {
      await this.queue.transaction(async repositories => {
        const pack = (await repositories.packs.store.list()).find(row => row.name === name)
        if (!pack) return
        if (options.publish && !pack.published) await repositories.packs.store.save({ ...pack, published: true })
        const groups = new Set((await this.accounts.listGroups()).map(group => group.id))
        for (const id of options.groups ?? [])
          if (groups.has(id)) await repositories.packs.grants.set(id, [...new Set([...(await repositories.packs.grants.get(id)), name])])
      })
    })
  }
  async suiteImpact(name: string): Promise<{ groups: readonly { id: string; name: string }[]; published: boolean; selectedMembers: number } | undefined> {
    const pack = (await this.packs.store.list()).find(row => row.name === name)
    if (!pack) return undefined
    const groups = await Promise.all(
      (await this.accounts.listGroups()).map(async group => ({ group, granted: (await this.packs.grants.get(group.id)).includes(name) })),
    )
    const selected = await Promise.all((await this.accounts.list()).map(async account => (await this.packs.selections.get(account.spaceId)).includes(name)))
    return {
      groups: groups.filter(row => row.granted).map(({ group: { id, name } }) => ({ id, name })),
      published: pack.published,
      selectedMembers: selected.filter(Boolean).length,
    }
  }
  /** Manual packs that reference a skill block suite uninstalls until the reference is removed. */
  async manualPacksContaining(name: string): Promise<readonly string[]> {
    return (await this.packs.store.list()).filter(pack => pack.suiteOrigin === undefined && pack.skills.includes(name)).map(pack => pack.name)
  }
  private async packInputInvalid(input: { name: string; description: string; skills: readonly string[]; instructions: string }): Promise<boolean> {
    const library = await this.library.list()
    return (
      !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(input.name) ||
      input.name.length > 64 ||
      !input.description.trim() ||
      input.description.length > 4096 ||
      input.instructions.length > 100_000 ||
      new Set(input.skills).size !== input.skills.length ||
      input.skills.length > 256 ||
      input.skills.some(name => !library.some(skill => skill.name === name))
    )
  }
  private async assertNotSuite(name: string): Promise<void> {
    const pack = (await this.packs.store.list()).find(row => row.name === name)
    if (pack?.suiteOrigin)
      throw new BusinessRuleError('forbidden', 'Suite catalog entries are read-only. Uninstall the suite or detach the entry first.', 'suite-entry-locked')
  }
  async market(actor: CommunityAccountActor): Promise<readonly CommunityMarketPack[]> {
    const account = await this.current(actor),
      group = (await this.accounts.listGroups()).find(group => group.id === account.groupId)
    if (!group) return []
    const library = await this.library.list(),
      granted = await this.packs.grants.get(group.id),
      selected = await this.packs.selections.get(account.spaceId)
    return (await this.packs.store.list()).flatMap(pack => {
      const skills = pack.skills.filter(name => library.some(skill => skill.name === name && !skill.conflict))
      const source = granted.includes(pack.name) ? ('managed' as const) : pack.published && selected.includes(pack.name) ? ('selected' as const) : null
      return skills.length && (pack.published || source)
        ? [{ name: pack.name, description: pack.description, instructions: pack.instructions, skills, source }]
        : []
    })
  }
  select(actor: CommunityAccountActor, name: string, selected: boolean): Promise<void> {
    return this.queue.mutate(async () => {
      const account = await this.current(actor),
        pack = await this.required(name),
        view = (await this.market(actor)).find(row => row.name === name)
      if (!pack.published || !view || view.source === 'managed') throw new BusinessRuleError('conflict', 'Skill selection is unavailable.', 'skill-unavailable')
      const values = (await this.packs.selections.get(account.spaceId)).filter(value => value !== name)
      await this.packs.selections.set(account.spaceId, selected ? [...values, name] : values)
    })
  }
  private async view(actor: CommunityAccountActor, pack: SkillPack, revision?: string): Promise<CommunitySkillPackView> {
    return {
      name: pack.name,
      description: pack.description,
      skills: pack.skills,
      instructions: pack.instructions,
      published: pack.published,
      ...(pack.suiteOrigin !== undefined ? { suiteOrigin: pack.suiteOrigin } : {}),
      empty: !pack.skills.length,
      conflict: !!pack.note?.conflict,
      revision: revision ?? (await this.revision(actor)),
    }
  }
  private async required(name: string): Promise<SkillPack> {
    const pack = (await this.packs.store.list()).find(pack => pack.name === name)
    if (!pack) throw new BusinessRuleError('missing', 'Skill pack was not found.', 'skill-unavailable')
    return pack
  }
  private async fresh(actor: CommunityAccountActor, name: string, revision: string) {
    if ((await this.revision(actor)) !== revision) throw new BusinessRuleError('conflict', 'Review the skill again before confirming.', 'skill-preview-changed')
  }
  private async current(actor: CommunityAccountActor) {
    const account = await this.accounts.get(actor.username)
    if (!account || account.disabled || account.spaceId !== actor.spaceId || account.sessionEpoch !== actor.sessionEpoch)
      throw new CommunityAuthenticationError('Sign in is required', 'sign-in-required')
    return account
  }
  private async admin(actor: CommunityAccountActor) {
    if (!(await this.current(actor)).admin) throw new BusinessRuleError('forbidden', 'Administrator access is required', 'admin-required')
  }
}
