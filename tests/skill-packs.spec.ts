import { expect, it } from 'vitest'
import { postgresSkillService } from './fixtures/postgres-skill-service.js'

it('pages matching skill summaries by stable cursor and rejects a member request', async () => {
  const fixture = await postgresSkillService()
  try {
    for (let index = 0; index < 26; index++) {
      const name = 'candidate-' + String(index).padStart(2, '0')
      await fixture.storage.library.save({ name, description: 'Literal 100% match', hash: name, published: false, importedAt: 0 })
    }
    await fixture.storage.library.save({ name: 'other', description: 'Different', hash: 'other', published: false, importedAt: 0 })
    const first = await fixture.packs.candidates(fixture.actor, '100%', '')
    expect(first.rows).toHaveLength(24)
    expect(first.next).toBe('candidate-23')
    expect(await fixture.packs.candidates(fixture.actor, '100%', first.next!)).toEqual({
      rows: ['candidate-24', 'candidate-25'].map(name => ({ name, description: 'Literal 100% match' })),
    })
    await expect(fixture.packs.candidates(fixture.member, '', '')).rejects.toMatchObject({ code: 'admin-required' })
  } finally {
    await fixture.close()
  }
})

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
    await service.publish(actor, input.name, true, await service.revision(actor))
    expect((await service.list(actor))[0]).toMatchObject({ ...input, empty: false })
    expect((await service.market(actor))[0]?.source).toBeNull()
    expect((await service.detail(actor, 'research')).removal.groups).toEqual([])
    await packs.grants.set('admin', ['research'])
    expect((await service.market(actor))[0]?.source).toBe('managed')
    expect((await service.detail(actor, 'research')).removal.groups.map(row => row.id)).toEqual(['admin'])
    await packs.grants.set('admin', [])
    await service.save(actor, { ...input, name: 'other', skills: ['one'], instructions: '' }, await service.revision(actor))
    await service.publish(actor, 'other', true, await service.revision(actor))
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

it('keeps pack publication independent from saving content', async () => {
  const f = await postgresSkillService()
  try {
    const input = { name: 'workflow', description: 'A workflow', skills: [], instructions: '', published: true }
    await f.packs.save(f.actor, input, await f.packs.revision(f.actor))
    expect((await f.packs.detail(f.actor, 'workflow')).published).toBe(false)
    await f.packs.publish(f.actor, 'workflow', true, await f.packs.revision(f.actor))
    expect((await f.packs.detail(f.actor, 'workflow')).published).toBe(true)
    await f.packs.save(f.actor, { ...input, description: 'Edited', published: false }, await f.packs.revision(f.actor))
    expect((await f.packs.detail(f.actor, 'workflow')).published).toBe(true)
    const stale = await f.packs.revision(f.actor)
    await f.storage.packs.selections.set(f.member.spaceId, ['workflow'])
    await expect(f.packs.publish(f.actor, 'workflow', false, stale)).rejects.toMatchObject({ code: 'skill-preview-changed' })
    await f.packs.publish(f.actor, 'workflow', false, await f.packs.revision(f.actor))
    expect((await f.packs.detail(f.actor, 'workflow')).published).toBe(false)
    await f.packs.save(f.actor, input, await f.packs.revision(f.actor))
    expect((await f.packs.detail(f.actor, 'workflow')).published).toBe(false)
  } finally {
    await f.close()
  }
})

it('unpublishes catalog packs without dropping grants, restores no selections and explains unavailable contents', async () => {
  const f = await postgresSkillService()
  try {
    await f.storage.library.save({ name: 'child', description: 'Child', hash: 'child', importedAt: 0, published: false })
    await f.packs.commitSuitePack('suite:test', { name: 'catalog-pack', description: 'Catalog pack', skills: ['child'], instructions: '' })
    await f.packs.publish(f.actor, 'catalog-pack', true, await f.packs.revision(f.actor))
    await f.storage.packs.grants.set('admin', ['catalog-pack'])
    await f.packs.select(f.member, 'catalog-pack', true)
    const detail = await f.packs.detail(f.actor, 'catalog-pack')
    expect(detail.removal.selectedMembers).toBe(1)
    await expect(f.packs.save(f.actor, detail, detail.revision)).rejects.toMatchObject({ code: 'suite-entry-locked' })
    await f.packs.publish(f.actor, 'catalog-pack', false, detail.revision)
    expect(await f.storage.packs.grants.get('admin')).toEqual(['catalog-pack'])
    expect(await f.storage.packs.selections.get(f.member.spaceId)).toEqual([])
    await f.packs.updateSuitePack('suite:test', { name: 'catalog-pack', description: 'Updated', skills: ['child'], instructions: '' }, [])
    expect((await f.packs.detail(f.actor, 'catalog-pack')).published).toBe(false)
    await f.packs.publish(f.actor, 'catalog-pack', true, await f.packs.revision(f.actor))
    expect(await f.storage.packs.selections.get(f.member.spaceId)).toEqual([])
    await f.storage.library.save({ ...(await f.storage.library.list())[0]!, conflict: true })
    expect(await f.packs.detail(f.actor, 'catalog-pack')).toMatchObject({ published: true, unavailable: 'conflict', empty: false })
    expect(await f.packs.market(f.member)).toEqual([])
    await expect(f.packs.publish(f.member, 'catalog-pack', false, await f.packs.revision(f.actor))).rejects.toMatchObject({ code: 'admin-required' })
  } finally {
    await f.close()
  }
})

it('edits catalog display fields independently and keeps the pack identity across catalog updates', async () => {
  const f = await postgresSkillService()
  try {
    const { packs, actor, storage } = f
    await storage.library.save({ name: 'child', description: 'Child', hash: 'child', importedAt: 0, published: false })
    const definition = { name: 'catalog-pack', catalogDisplayName: 'Original title', description: 'Original description', skills: ['child'], instructions: '' }
    await packs.commitSuitePack('suite:test', definition)
    await packs.publish(actor, definition.name, true, await packs.revision(actor))
    await storage.packs.grants.set('admin', [definition.name])
    const stale = (await packs.detail(actor, definition.name)).revision
    await packs.saveDisplay(actor, definition.name, { displayName: 'Original title' }, stale)
    await packs.updateSuitePack('suite:test', { ...definition, catalogDisplayName: 'Updated title', description: 'Updated description' }, [])
    await expect(packs.saveDisplay(actor, definition.name, { description: 'Stale edit' }, stale)).rejects.toMatchObject({ code: 'skill-preview-changed' })
    expect(await packs.detail(actor, definition.name)).toMatchObject({
      name: definition.name,
      displayName: 'Original title',
      description: 'Updated description',
      skills: ['child'],
      published: true,
    })
    f.fault.commit = true
    const revision = await packs.revision(actor)
    await expect(packs.saveDisplay(actor, definition.name, { description: 'Will roll back' }, revision)).rejects.toThrow('commit failed')
    expect(await packs.detail(actor, definition.name)).toMatchObject({ description: 'Updated description' })
    await expect(packs.saveDisplay(f.member, definition.name, { description: 'Unauthorized' }, revision)).rejects.toMatchObject({ code: 'admin-required' })
    expect(await packs.market(f.member)).toContainEqual(expect.objectContaining({ name: definition.name, displayName: 'Original title' }))
    expect(await storage.packs.grants.get('admin')).toEqual([definition.name])
  } finally {
    await f.close()
  }
})

it.each([
  { label: 'neither field', edit: {}, title: 'New title', description: 'New description' },
  { label: 'description only', edit: { description: 'Local description' }, title: 'New title', description: 'Local description' },
  {
    label: 'both fields',
    edit: { displayName: 'Local title', description: 'Local description' },
    title: 'Local title',
    description: 'Local description',
  },
])('preserves catalog display intent on update after editing $label', async ({ edit, title, description }) => {
  const f = await postgresSkillService()
  try {
    const { packs, actor, storage } = f
    await storage.library.save({ name: 'child', description: 'Child', hash: 'child', importedAt: 0, published: false })
    const definition = { name: 'catalog-pack', catalogDisplayName: 'Original title', description: 'Original description', skills: ['child'], instructions: '' }
    await packs.commitSuitePack('suite:test', definition)
    await packs.publish(actor, definition.name, true, await packs.revision(actor))
    await storage.packs.grants.set('admin', [definition.name])
    await storage.packs.selections.set(f.member.spaceId, [definition.name])
    if (Object.keys(edit).length) await packs.saveDisplay(actor, definition.name, edit, await packs.revision(actor))
    await packs.updateSuitePack('suite:test', { ...definition, catalogDisplayName: 'New title', description: 'New description' }, [])
    expect(await packs.detail(actor, definition.name)).toMatchObject({
      name: definition.name,
      displayName: title,
      description,
      skills: ['child'],
      published: true,
    })
    expect(await storage.packs.grants.get('admin')).toEqual([definition.name])
    expect(await storage.packs.selections.get(f.member.spaceId)).toEqual([definition.name])
  } finally {
    await f.close()
  }
})
