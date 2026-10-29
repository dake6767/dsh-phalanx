import { expect, it } from 'vitest'
import { postgresSkillService } from './fixtures/postgres-skill-service.js'

it('rolls back a cascading pack deletion before commit and permits a fresh explicit retry', async () => {
  const f = await postgresSkillService()
  try {
    for (const name of ['one', 'two', 'retained'])
      await f.storage.library.save({ name, description: name, hash: 'a'.repeat(64), importedAt: 0, published: true })
    await f.storage.grants.set('default', ['retained'])
    const input = { name: 'bundle', description: 'Bundle', skills: ['one', 'two', 'retained'], instructions: '', published: true }
    await f.packs.save(f.actor, input, await f.packs.revision(f.actor))
    await f.storage.packs.grants.set('default', ['bundle'])
    await f.storage.packs.selections.set(f.member.spaceId, ['bundle'])
    const before = { skills: await f.storage.library.list(), packs: await f.storage.packs.store.list() }
    f.fault.commit = true
    await expect(f.packs.remove(f.actor, 'bundle', true, await f.packs.revision(f.actor))).rejects.toThrow('commit failed')
    expect({ skills: await f.storage.library.list(), packs: await f.storage.packs.store.list() }).toEqual(before)
    expect(await f.storage.packs.grants.get('default')).toEqual(['bundle'])
    expect(await f.storage.packs.selections.get(f.member.spaceId)).toEqual(['bundle'])
    await f.library.recover()
    expect(await f.storage.packs.store.list()).toEqual(before.packs)
    await f.packs.remove(f.actor, 'bundle', true, await f.packs.revision(f.actor))
    expect((await f.storage.library.list()).map(row => row.name)).toEqual(['retained'])
    expect(await f.storage.packs.store.list()).toEqual([])
    expect(await f.storage.packs.grants.get('default')).toEqual([])
    expect(await f.storage.packs.selections.get(f.member.spaceId)).toEqual([])
  } finally {
    await f.close()
  }
})

it('keeps a committed deletion when projection fails and retries only synchronization', async () => {
  const f = await postgresSkillService()
  try {
    await f.storage.library.save({ name: 'one', description: 'One', hash: 'a'.repeat(64), importedAt: 0, published: true })
    await f.packs.save(f.actor, { name: 'bundle', description: 'Bundle', skills: ['one'], instructions: '', published: true }, await f.packs.revision(f.actor))
    f.fault.projection = true
    await expect(f.packs.remove(f.actor, 'bundle', true, await f.packs.revision(f.actor))).rejects.toMatchObject({ code: 'skill-sync-failed' })
    expect(await f.storage.library.list()).toEqual([])
    expect(await f.storage.packs.store.list()).toEqual([])
    expect(await f.library.synchronization(f.actor)).toEqual({ pending: true })
    await f.library.retrySynchronization(f.actor)
    expect(await f.library.synchronization(f.actor)).toEqual({ pending: false })
  } finally {
    await f.close()
  }
})
