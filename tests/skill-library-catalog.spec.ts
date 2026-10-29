import { expect, it } from 'vitest'
import { postgresSkillService } from './fixtures/postgres-skill-service.js'

it('keeps a staged catalog import available after transaction rollback and restores dropped relations on projection failure', async () => {
  const f = await postgresSkillService({
    accept: async () => {
      throw Error('unused')
    },
    acceptGit: async () => ({
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
