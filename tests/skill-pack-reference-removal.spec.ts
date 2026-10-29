import { expect, it, vi } from 'vitest'
import { PostgresExpertReferences } from '../src/adapters/postgres-expert-references.js'
import { expertApplication } from './fixtures/expert-application.js'

it('previews the union selected by deleteSkills, preserves shared skills and bumps each expert once', async () => {
  const fixture = await expertApplication(),
    { api } = fixture
  try {
    await fixture.uploadSkill('reports')
    await fixture.uploadSkill('shared')
    const savePack = async (name: string, skills: string[]) => {
      const current = await api<{ revision: string }>('skill-packs')
      await api('skill-packs', {
        action: 'save',
        revision: current.revision,
        pack: { name, description: 'Reports', instructions: '', skills, published: false },
      })
    }
    await savePack('report-pack', ['reports', 'shared'])
    await savePack('other-pack', ['shared'])
    const library = await api<{ revision: string }>('experts')
    const created = await api<{ experts: { id: string; revision: number }[] }>('experts', {
      revision: library.revision,
      expert: {
        name: 'Report expert',
        description: 'Writes reports',
        icon: 'R',
        persona: 'Write clearly.',
        skills: ['reports', 'shared'],
        skillPacks: ['report-pack'],
      },
    })
    const before = created.experts[0]!
    const detail = await api<{
      revision: string
      removal: { experts: { id: string; name: string }[]; expertsWithSkills: { id: string; name: string }[]; deleting: string[] }
    }>('skill-packs/detail?name=report-pack')
    expect(detail.removal.experts).toEqual([{ id: before.id, name: 'Report expert' }])
    expect(detail.removal.expertsWithSkills).toEqual(detail.removal.experts)
    expect(detail.removal.deleting).toEqual(['reports'])
    await api('skill-packs', { action: 'remove', name: 'report-pack', deleteSkills: true, revision: detail.revision })
    const after = await api<{ experts: { id: string; revision: number; skills: string[]; skillPacks: string[]; missing: string[] }[] }>('experts')
    expect(after.experts).toMatchObject([{ id: before.id, revision: before.revision + 1, skills: ['shared'], skillPacks: [], missing: [] }])
  } finally {
    await fixture.close()
  }
})

it('carries expert references across a pack rename and invalidates its running content revision', async () => {
  const fixture = await expertApplication(),
    { api } = fixture
  try {
    await fixture.uploadSkill('reports')
    const library = await api<{ revision: string }>('skill-packs')
    const pack = { name: 'report-pack', description: 'Reports', instructions: '', skills: ['reports'], published: false }
    await api('skill-packs', { action: 'save', revision: library.revision, pack })
    const current = await api<{ revision: string }>('experts')
    const before = await api<{ experts: { revision: number }[] }>('experts', {
      revision: current.revision,
      expert: { name: 'Writer', description: 'Reports', icon: 'W', persona: 'Write.', skills: [], skillPacks: ['report-pack'] },
    })
    const detail = await api<{ revision: string }>('skill-packs/detail?name=report-pack')
    await api('skill-packs', { action: 'save', revision: detail.revision, previousName: 'report-pack', pack: { ...pack, name: 'renamed-pack' } })
    expect((await api<{ experts: unknown[] }>('experts')).experts).toMatchObject([
      { skillPacks: ['renamed-pack'], revision: before.experts[0]!.revision + 1, missing: [] },
    ])
  } finally {
    await fixture.close()
  }
})

it('does not attach a newer confirmation token to an expert impact captured before a concurrent reference arrived', async () => {
  const fixture = await expertApplication(),
    { api, request } = fixture
  let restore = () => {}
  try {
    await fixture.uploadSkill('reports')
    const library = await api<{ revision: string }>('skill-packs')
    await api('skill-packs', {
      action: 'save',
      revision: library.revision,
      pack: { name: 'report-pack', description: 'Reports', instructions: '', skills: ['reports'], published: false },
    })
    const addExpert = async (name: string) => {
      const current = await api<{ revision: string }>('experts')
      await api('experts', {
        revision: current.revision,
        expert: { name, description: 'Reports', icon: 'W', persona: 'Write.', skills: [], skillPacks: ['report-pack'] },
      })
    }
    await addExpert('Original expert')
    let armed = true
    const original = PostgresExpertReferences.prototype.impact
    const spy = vi.spyOn(PostgresExpertReferences.prototype, 'impact').mockImplementation(async function (this: PostgresExpertReferences, targets) {
      const captured = await original.call(this, targets)
      if (armed && targets.length === 1 && targets[0]?.kind === 'pack') {
        armed = false
        await addExpert('Late expert')
      }
      return captured
    })
    restore = () => spy.mockRestore()
    const preview = await api<{ revision: string; removal: { experts: { name: string }[] } }>('skill-packs/detail?name=report-pack')
    expect(preview.removal.experts.map(row => row.name)).toEqual(['Original expert'])
    expect((await request('skill-packs', { action: 'remove', name: 'report-pack', deleteSkills: false, revision: preview.revision })).status).toBe(409)
    expect((await api<{ packs: unknown[] }>('skill-packs')).packs).toHaveLength(1)
    expect((await api<{ experts: { skillPacks: string[] }[] }>('experts')).experts.map(row => row.skillPacks)).toEqual([['report-pack'], ['report-pack']])
  } finally {
    restore()
    await fixture.close()
  }
})
