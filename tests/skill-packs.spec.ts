import { expect, it } from 'vitest'
import { postgresSkillService } from './fixtures/postgres-skill-service.js'

it('creates ordered references and a note, previews conservative cascading deletion and rejects stale decisions', async () => {
  const f = await postgresSkillService()
  const {
    actor,
    packs: service,
    library,
    storage: { library: store, packs, selections: choices },
  } = f
  try {
    for (const name of ['one', 'two', 'three']) await store.save({ name, description: name, hash: name, published: false, importedAt: 0 })
    await f.storage.grants.set('default', ['two'])
    const input = { name: 'research', description: 'Research', skills: ['three', 'one', 'two'], instructions: 'Read one then two', published: true }
    await service.save(actor, input, await service.revision(actor))
    expect((await service.list(actor))[0]).toMatchObject({ ...input, empty: false })
    expect((await service.market(actor))[0]?.source).toBeNull()
    expect((await service.detail(actor, 'research')).removal.groups).toEqual([])
    await packs.grants.set('admin', ['research'])
    expect((await service.market(actor))[0]?.source).toBe('managed')
    expect((await service.detail(actor, 'research')).removal.groups.map(row => row.id)).toEqual(['admin'])
    await packs.grants.set('admin', [])
    await service.save(actor, { ...input, name: 'other', skills: ['one'], instructions: '' }, await service.revision(actor))
    await packs.grants.set('default', ['research', 'other'])
    await packs.selections.set(f.member.spaceId, ['research', 'other'])
    f.fault.commit = true
    await expect(service.save(actor, { ...input, name: 'renamed', skills: ['one'], instructions: '' }, await service.revision(actor), 'other')).rejects.toThrow(
      'commit failed',
    )
    expect((await service.list(actor)).map(pack => pack.name)).toEqual(['other', 'research'])
    expect(await packs.grants.get('default')).toEqual(['other', 'research'])
    await service.save(actor, { ...input, name: 'renamed', skills: ['one'], instructions: '' }, await service.revision(actor), 'other')
    expect((await service.list(actor)).map(pack => pack.name)).toEqual(['renamed', 'research'])
    expect(await packs.grants.get('default')).toEqual(['renamed', 'research'])
    expect(await packs.selections.get(f.member.spaceId)).toEqual(['renamed', 'research'])
    await store.save({ ...(await store.list()).find(row => row.name === 'one')!, conflict: true })
    const renamed = (await service.list(actor)).find(pack => pack.name === 'renamed')!
    await service.save(
      actor,
      { name: renamed.name, description: 'Changed', skills: renamed.skills, instructions: '', published: true },
      await service.revision(actor),
    )
    await expect(service.save(actor, { ...input, name: 'new-pack', skills: ['one'] }, await service.revision(actor))).rejects.toMatchObject({
      code: 'skill-pack-invalid',
    })
    await store.save({ ...(await store.list()).find(row => row.name === 'one')!, conflict: false })
    await packs.selections.set(f.member.spaceId, [])
    await choices.set(f.member.spaceId, ['three'])
    const directImpact = await service.detail(actor, 'research')
    expect(directImpact.removal).toMatchObject({ selectedMembers: 0, selectedMembersWithSkills: 1 })
    await choices.set(f.member.spaceId, [])
    await expect(service.remove(actor, 'research', true, directImpact.revision)).rejects.toMatchObject({ code: 'skill-preview-changed' })
    await packs.selections.set(f.member.spaceId, ['research'])
    const preview = await service.detail(actor, 'research')
    expect(preview.removal).toMatchObject({
      deleting: ['three'],
      retained: [
        { name: 'one', reasons: ['other-pack'] },
        { name: 'two', reasons: ['direct-grant'] },
      ],
      selectedMembers: 1,
    })
    expect(preview.removal.groups.map(group => group.id)).toContain('default')
    await expect(service.remove(actor, 'research', true, 'stale')).rejects.toMatchObject({ code: 'skill-preview-changed' })
    await service.remove(actor, 'research', true, preview.revision)
    expect((await store.list()).map(row => row.name)).toEqual(['one', 'two'])
    const one = await library.detail(actor, 'one')
    expect(one.packs).toEqual(['renamed'])
    await library.remove(actor, 'one', one.revision)
    expect((await service.list(actor))[0]).toMatchObject({ name: 'renamed', skills: [], empty: true })
    await expect(service.save(f.member, input, '')).rejects.toMatchObject({ code: 'admin-required' })
  } finally {
    await f.close()
  }
})
