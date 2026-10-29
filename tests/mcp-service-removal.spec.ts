import { expect, it } from 'vitest'
import { expertApplication } from './fixtures/expert-application.js'

it('requires the reviewed MCP expert impact and atomically retires references in the confirmed deletion', async () => {
  const fixture = await expertApplication(),
    { api, request } = fixture
  try {
    await api('mcp', { action: 'save', create: true, service: { name: 'p-reports', description: 'Reports', url: 'https://example.test' } })
    const library = await api<{ revision: string }>('experts')
    const created = await api<{ experts: { id: string; revision: number }[] }>('experts', {
      revision: library.revision,
      expert: { name: 'Report expert', description: 'Writes reports', icon: 'R', persona: 'Write clearly.', skills: [], skillPacks: [], mcp: ['p-reports'] },
    })
    const before = created.experts[0]!
    const impact = await api<{ revision: string; experts: { id: string; name: string }[] }>('mcp?impact=p-reports')
    expect(impact.experts).toEqual([{ id: before.id, name: 'Report expert' }])
    expect((await request('mcp', { action: 'remove', name: 'p-reports' })).status).toBe(409)
    expect((await api<{ experts: { mcp: string[] }[] }>('experts')).experts[0]!.mcp).toEqual(['p-reports'])
    await api('mcp', { action: 'remove', name: 'p-reports', revision: impact.revision })
    const after = await api<{ experts: { id: string; revision: number; mcp: string[]; missing: string[] }[] }>('experts')
    expect(after.experts).toMatchObject([{ id: before.id, mcp: [], missing: [] }])
    expect(after.experts[0]!.revision).toBeGreaterThan(before.revision)
  } finally {
    await fixture.close()
  }
})
