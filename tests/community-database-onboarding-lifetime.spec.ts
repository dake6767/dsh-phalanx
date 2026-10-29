import { expect, it } from 'vitest'
import { CommunityDatabaseOnboarding } from '../src/use-cases/community-database-onboarding.js'

it('stops admitting database setup work and drains an accepted selection before closing', async () => {
  let entered!: () => void,
    release!: () => void,
    selected = false,
    activated = false,
    closed = false
  const began = new Promise<void>(resolve => {
      entered = resolve
    }),
    gate = new Promise<void>(resolve => {
      release = resolve
    })
  const service = new CommunityDatabaseOnboarding(
    { verify: value => value === 'fixture-invitation', consume() {} },
    {
      pending: () => !selected,
      inspect: async () => ({ ok: true, checks: [] }),
      select: async () => {
        entered()
        await gate
        selected = true
      },
    },
    async () => {
      activated = true
    },
    () => {},
  )
  const selecting = service.select('fixture-invitation')
  try {
    await began
    const closing = service.close().then(() => {
      closed = true
    })
    await expect(service.test('fixture-invitation')).rejects.toMatchObject({ code: 'database-setup-closed' })
    expect(closed).toBe(false)
    release()
    await selecting
    await closing
    expect(selected).toBe(true)
    expect(activated).toBe(true)
    expect(closed).toBe(true)
  } finally {
    release()
    await selecting
  }
})

it('keeps the selected platform alive when a stale setup page submits a conflicting database choice', async () => {
  let failed = 0,
    activated = 0
  const service = new CommunityDatabaseOnboarding(
    { verify: value => value === 'fixture-invitation', consume() {} },
    {
      pending: () => false,
      inspect: async () => ({ ok: true, checks: [] }),
      select: async () => {
        throw Error('fixture selection already committed')
      },
    },
    async () => {
      activated++
    },
    () => {
      failed++
    },
  )
  try {
    await expect(service.select('fixture-invitation')).rejects.toThrow('selection already committed')
    expect(failed).toBe(0)
    expect(activated).toBe(0)
    await service.resume('fixture-invitation')
    expect(activated).toBe(1)
  } finally {
    await service.close()
  }
})
