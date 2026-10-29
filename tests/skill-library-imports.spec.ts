import { expect, it } from 'vitest'
import { postgresSkillService } from './fixtures/postgres-skill-service.js'

it('holds a candidate set for review, requires each replacement and imports the selected orchestration as a pack note', async () => {
  const candidates = ['one', 'two', 'workflow'].map(name => ({
    name,
    description: name,
    hash: name,
    markdown: '# ' + name,
    files: ['SKILL.md'],
    path: name,
    internal: false,
    orchestration: name === 'workflow',
    warnings: [],
  }))
  let retained: readonly string[] = []
  const fixture = await postgresSkillService({
    accept: async () => {
      throw Error('unused')
    },
    acceptImport: async () => ({ candidates, packs: [] }),
    createNote: async (name, description, markdown) => ({ name, description, markdown, files: ['SKILL.md'], hash: 'note' }),
    read: async () => ({ markdown: '', files: [] }),
    newToken: () => 'token',
    collect: async value => {
      retained = value
    },
  })
  const { actor, library: service } = fixture
  try {
    await fixture.storage.library.save({ name: 'one', description: 'Old', hash: 'old', published: true, importedAt: 0 })
    async function* bytes() {
      yield new Uint8Array([1])
    }
    const preview = await service.previewImport(actor, bytes(), new AbortController().signal, 'bundle.zip')
    expect(await service.list(actor)).toHaveLength(1)
    expect(retained).toEqual(expect.arrayContaining(['old', 'one', 'two', 'workflow']))
    expect(preview).toMatchObject({
      defaultPackName: 'workflow',
      candidates: [expect.objectContaining({ name: 'one', replacing: true }), expect.anything(), expect.anything()],
    })
    const selected = {
      token: preview.token,
      names: ['one', 'two'],
      replacements: [],
      packs: [{ name: 'workflow', description: 'Workflow', skills: ['two', 'one'], note: 'workflow' }],
    }
    await expect(service.confirmImport(actor, selected)).rejects.toMatchObject({ code: 'skill-preview-changed' })
    fixture.fault.commit = true
    await expect(service.confirmImport(actor, { ...selected, replacements: ['one'] })).rejects.toThrow('commit failed')
    expect((await service.list(actor)).map(row => row.hash)).toEqual(['old'])
    expect(await fixture.storage.packs.store.list()).toEqual([])
    expect(retained).toContain('one')
    expect(retained).not.toContain('note')
    await service.confirmImport(actor, { ...selected, replacements: ['one'] })
    expect((await service.list(actor)).map(row => [row.name, row.published])).toEqual([
      ['one', true],
      ['two', false],
    ])
    expect((await fixture.storage.packs.store.list()).find(row => row.name === 'workflow')).toMatchObject({
      skills: ['two', 'one'],
      note: { hash: 'note' },
      instructions: '# workflow',
    })
    expect(retained).toEqual(expect.arrayContaining(['one', 'two', 'note']))
    expect(retained).not.toContain('workflow')
    expect(retained).not.toContain('old')
    await service.confirmImport(actor, { ...selected, replacements: ['one'] })
    const cancelled = await service.previewImport(actor, bytes(), new AbortController().signal, 'bundle.zip')
    await service.cancel(actor, cancelled.token)
    await expect(service.confirmImport(actor, { ...selected, token: cancelled.token, replacements: ['one'] })).rejects.toMatchObject({
      code: 'skill-preview-changed',
    })
    expect(retained).not.toContain('workflow')
  } finally {
    await fixture.close()
  }
})
