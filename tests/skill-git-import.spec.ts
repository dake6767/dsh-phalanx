import { asyncSkillFacts } from './fixtures/async-skill-facts.js'
import { expect, it } from 'vitest'
import { SkillLibrary } from './fixtures/skill-library.js'
import type { LibrarySkill } from '../src/domain/skill-library.js'
import type { SkillGitTarget } from '../src/domain/skill-git-source.js'

it('stores Git provenance and reviews changed, added and removed skills without automatic updates', async () => {
  const actor = { username: 'admin', spaceId: 'space', sessionEpoch: 0 },
    rows = new Map<string, LibrarySkill>()
  let token = 0,
    version = 1
  const candidates = (source: SkillGitTarget) =>
    (version === 1 ? ['one', 'gone'] : ['one', 'new']).map(name => ({
      name,
      description: name,
      hash: `${name}-${version}`,
      markdown: '# ' + name,
      files: ['SKILL.md'],
      path: name,
      internal: false,
      orchestration: false,
      warnings: [],
      source: { ...source, path: name, commit: String(version).repeat(40), contentHash: `${name}-${version}` },
    }))
  const service = new SkillLibrary(
    { get: async () => ({ ...actor, admin: true, disabled: false, groupId: 'admins', email: '', createdAt: 0, updatedAt: 0 }) },
    asyncSkillFacts({
      list: async () => [...rows.values()],
      save: row => {
        rows.set(row.name, row)
      },
      remove: name => {
        rows.delete(name)
      },
    }),
    {
      accept: async () => {
        throw new Error('unused')
      },
      acceptGit: async source => ({ candidates: candidates(source), packs: [] }),
      read: async () => ({ markdown: '', files: [] }),
      newToken: () => String(++token),
      collect: async () => {},
    },
    { now: () => 1 },
    undefined,
    undefined,
    [],
    undefined,
    undefined,
  )
  const first = await service.previewGit(actor, 'owner/repo#main', new AbortController().signal)
  await service.confirmImport(actor, { token: first.token, names: ['one', 'gone'], replacements: [], packs: [] })
  expect((await service.detail(actor, 'one')).source).toMatchObject({ url: 'https://github.com/owner/repo.git', commit: '1'.repeat(40), contentHash: 'one-1' })
  version = 2
  const update = await service.previewGit(actor, '', new AbortController().signal, 'one')
  expect(update.candidates.map(row => [row.name, row.change])).toEqual([
    ['one', 'changed'],
    ['new', 'added'],
  ])
  expect(update.deleted?.map(row => row.name)).toEqual(['gone'])
  expect((await service.list(actor)).map(row => row.name)).toEqual(['one', 'gone'])
  await expect(
    service.confirmImport(actor, { token: update.token, names: ['one', 'new'], replacements: [], packs: [], removals: ['gone'] }),
  ).rejects.toMatchObject({ code: 'skill-preview-changed' })
  await service.confirmImport(actor, { token: update.token, names: ['one', 'new'], replacements: ['one'], packs: [], removals: ['gone'] })
  expect((await service.list(actor)).map(row => row.name)).toEqual(['one', 'new'])
  expect((await service.detail(actor, 'one')).source?.commit).toBe('2'.repeat(40))
})
