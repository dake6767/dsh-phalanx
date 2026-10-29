import { expect, it, vi } from 'vitest'
import { PostgresExpertStateQuery } from '../src/adapters/postgres-expert-state-query.js'
import { expertApplication } from './fixtures/expert-application.js'

for (const action of ['grant', 'publish'] as const)
  it(`rejects an old ${action} request whose validated snapshot preceded another administrator's commit`, async () => {
    const fixture = await expertApplication(),
      { api, request } = fixture
    let release = () => {},
      restore = () => {},
      pending: Promise<Response> | undefined
    try {
      const add = async (name: string) => {
        const current = await api<{ revision: string }>('experts')
        await api('experts', { revision: current.revision, expert: { name, description: 'Reports', icon: 'W', persona: 'Write.', skills: [], skillPacks: [] } })
      }
      await add('First')
      await add('Second')
      const current = await api<{ revision: string; experts: { id: string; name: string }[] }>('experts'),
        first = current.experts.find(row => row.name === 'First')!.id,
        second = current.experts.find(row => row.name === 'Second')!.id,
        groups = await api<{ id: string; kind: string }[]>('groups'),
        group = groups.find(row => row.kind === 'ordinary')!.id
      let captured!: () => void
      const paused = new Promise<void>(resolve => {
          captured = resolve
        }),
        gate = new Promise<void>(resolve => {
          release = resolve
        })
      let armed = true
      const read = PostgresExpertStateQuery.prototype.read,
        spy = vi.spyOn(PostgresExpertStateQuery.prototype, 'read').mockImplementation(async function (this: PostgresExpertStateQuery) {
          const snapshot = await read.call(this)
          if (armed) {
            armed = false
            captured()
            await gate
          }
          return snapshot
        })
      restore = () => spy.mockRestore()
      pending =
        action === 'grant'
          ? request(`groups/${group}/experts`, { names: [first], confirmed: true, revision: current.revision })
          : request('experts', { action: 'publish', id: first, published: true, confirmed: true, revision: current.revision })
      await paused
      if (action === 'grant') {
        await api(`groups/${group}/experts`, { names: [second], confirmed: true, revision: current.revision })
      } else {
        await api('experts', { action: 'publish', id: first, published: true, confirmed: true, revision: current.revision })
        const after = await api<{ revision: string }>('experts')
        await api('experts', { action: 'publish', id: first, published: false, confirmed: true, revision: after.revision })
      }
      release()
      expect((await pending).status).toBe(409)
      if (action === 'grant')
        expect(
          (await api<{ experts: { id: string; granted: boolean }[] }>(`groups/${group}/experts`)).experts.filter(row => row.granted).map(row => row.id),
        ).toEqual([second])
      else expect((await api<{ experts: { id: string; published: boolean }[] }>('experts')).experts.find(row => row.id === first)?.published).toBe(false)
    } finally {
      release()
      await Promise.allSettled(pending ? [pending] : [])
      restore()
      await fixture.close()
    }
  })
