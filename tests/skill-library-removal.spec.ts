import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { expertApplication } from './fixtures/expert-application.js'

it('previews the affected expert before deleting a skill and removes its reference in the confirmed change', async () => {
  const fixture = await expertApplication()
  const { root, api } = fixture
  try {
    await fixture.uploadSkill('reports')
    const library = await api<{ revision: string }>('experts')
    const created = await api<{ experts: { id: string; revision: number }[] }>('experts', {
      revision: library.revision,
      expert: { name: 'Report expert', description: 'Writes reports', icon: 'R', persona: 'Write clearly.', skills: ['reports'], skillPacks: [] },
    })
    const before = created.experts[0]!
    const impact = await api<{ revision: string; experts: { id: string; name: string }[] }>('skills/detail?name=reports')
    expect(impact.experts).toEqual([{ id: before.id, name: 'Report expert' }])
    await api('skills/change', { action: 'remove', name: 'reports', revision: impact.revision })
    const after = await api<{ experts: { id: string; revision: number; skills: string[]; missing: string[] }[] }>('experts')
    expect(after.experts).toMatchObject([{ id: before.id, skills: [], missing: [] }])
    expect(after.experts[0]!.revision).toBeGreaterThan(before.revision)
    await expect(stat(join(root, 'experts', 'library.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  } finally {
    await fixture.close()
  }
})
