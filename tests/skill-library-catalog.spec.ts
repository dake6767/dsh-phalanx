import { expect, it } from 'vitest'
import { postgresSkillService } from './fixtures/postgres-skill-service.js'

it('keeps a staged catalog import available after transaction rollback and restores dropped relations on projection failure', async () => {
  const f = await postgresSkillService({
    accept: async () => {
      throw Error('unused')
    },
    acceptGit: async () => ({
      failures: [],
      candidates: ['one', 'two'].map(name => ({
        name,
        description: name,
        hash: name,
        markdown: '',
        files: [],
        path: name,
        warnings: [],
        internal: false,
        orchestration: false,
      })),
      packs: [],
    }),
    read: async () => ({ markdown: '', files: [] }),
    collect: async () => {},
    newToken: () => 'token',
  })
  try {
    await f.library.prepareSuiteImport(
      'suite:test',
      { url: 'https://example.test/test.git', ref: 'main', subpath: '' },
      ['one', 'two'],
      async () => {},
      new AbortController().signal,
    )
    f.fault.commit = true
    await expect(f.library.commitSuiteSkills('suite:test')).rejects.toThrow('commit failed')
    expect(await f.storage.library.list()).toEqual([])
    await f.library.commitSuiteSkills('suite:test')
    await f.storage.grants.set('default', ['one'])
    await f.storage.packs.store.save({ name: 'manual', description: 'Manual', instructions: '', skills: ['one', 'two'], published: true })
    f.fault.projection = true
    let checkpoint: unknown
    await expect(
      f.library.dropSuiteSkills('suite:test', ['one'], value => {
        checkpoint = value
      }),
    ).rejects.toMatchObject({ code: 'skill-sync-failed' })
    expect((await f.storage.library.list()).map(row => row.name)).toEqual(['one', 'two'])
    expect(await f.storage.grants.get('default')).toEqual(['one'])
    expect((await f.storage.packs.store.list())[0]?.skills).toEqual(['one', 'two'])
    expect(checkpoint).toEqual({ grants: [], selections: [], packs: [] })
  } finally {
    await f.close()
  }
})

it('publishes catalog skills independently while retaining content ownership and clearing only selections', async () => {
  const f = await postgresSkillService()
  try {
    await f.storage.library.save({
      name: 'catalog-skill',
      description: 'Catalog skill',
      hash: 'catalog',
      importedAt: 0,
      published: false,
      suiteOrigin: 'suite:test',
    })
    await f.library.publish(f.actor, 'catalog-skill', true, (await f.library.detail(f.actor, 'catalog-skill')).revision)
    expect((await f.library.detail(f.actor, 'catalog-skill')).published).toBe(true)
    await f.storage.grants.set('admin', ['catalog-skill'])
    await f.library.select(f.member, 'catalog-skill', true)
    const before = await f.library.detail(f.actor, 'catalog-skill')
    await expect(f.library.remove(f.actor, 'catalog-skill', before.revision)).rejects.toMatchObject({ code: 'suite-entry-locked' })
    await f.library.publish(f.actor, 'catalog-skill', false, before.revision)
    expect(await f.storage.grants.get('admin')).toEqual(['catalog-skill'])
    expect(await f.storage.selections.get(f.member.spaceId)).toEqual([])
    await f.library.publish(f.actor, 'catalog-skill', true, (await f.library.detail(f.actor, 'catalog-skill')).revision)
    expect(await f.storage.selections.get(f.member.spaceId)).toEqual([])
  } finally {
    await f.close()
  }
})
