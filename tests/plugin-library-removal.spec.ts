import { expect, it } from 'vitest'
import { declaredRuntimeRevision } from '../src/adapters/runtime-revision.js'
import { expertApplication } from './fixtures/expert-application.js'

it('names affected experts before a plugin removal and clears their references in its transaction', async () => {
  const fixture = await expertApplication({
      pluginPreparer: {
        prepare: async input => ({
          ...input,
          integrity: 'fixture-integrity',
          artifact: 'fixture-artifact',
          runtimeRevision: declaredRuntimeRevision(),
          title: 'Reports',
          description: 'Fixture',
          dependencies: {},
          bundlePatch: JSON.stringify([{ id: 'tools', insert: [{ id: 'main', name: './main.js' }] }]),
        }),
      },
    }),
    { api, request } = fixture
  try {
    expect((await request('plugins', { action: 'add', packageName: '@fixture/reports', version: '1.0.0' })).status).toBe(202)
    await expect.poll(async () => (await api<{ stage: string }[]>('plugins'))[0]?.stage, { timeout: 5000 }).toBe('available')
    const library = await api<{ revision: string }>('experts')
    const created = await api<{ experts: { id: string; revision: number }[] }>('experts', {
      revision: library.revision,
      expert: {
        name: 'Report expert',
        description: 'Writes reports',
        icon: 'R',
        persona: 'Write clearly.',
        skills: [],
        skillPacks: [],
        plugins: ['@fixture/reports'],
      },
    })
    const before = created.experts[0]!
    const impact = await api<{ revision: string; experts: { id: string; name: string }[] }>('plugins/impact?packageName=%40fixture%2Freports')
    expect(impact.experts).toEqual([{ id: before.id, name: 'Report expert' }])
    await api('plugins/change', { action: 'remove', packageName: '@fixture/reports', revision: impact.revision, confirmed: true })
    const after = await api<{ experts: { id: string; revision: number; plugins: string[]; missing: string[] }[] }>('experts')
    expect(after.experts).toMatchObject([{ id: before.id, plugins: [], missing: [] }])
    expect(after.experts[0]!.revision).toBeGreaterThan(before.revision)
  } finally {
    await fixture.close()
  }
})
