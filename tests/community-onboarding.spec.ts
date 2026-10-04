import { describe, expect, it } from 'vitest'
import { CommunityOnboarding } from '../src/use-cases/community-onboarding.js'
import type { CommunityAccountRecord } from '../src/domain/community-account.js'
import type { CommunityAccountOnboardingStorePort } from '../src/ports/community-accounts.js'

const admin: CommunityAccountRecord = { username: 'admin', email: 'admin@example.test', admin: true,
  spaceId: 'fixture-space', disabled: false, sessionEpoch: 0, createdAt: 0, updatedAt: 0 }

describe('community onboarding', () => {
  it('allows only a current administrator to create a member', async () => {
    const records = new Map<string, CommunityAccountRecord>([[admin.username, admin]])
    const accounts: CommunityAccountOnboardingStorePort = {
      get: username => records.get(username), getState: username => records.get(username),
      list: () => [...records.values()], bootstrapComplete: () => true,
      authenticate: async () => undefined,
      createFirstAdmin: async () => admin,
      create: async input => { const record = { ...admin, username: input.username, email: input.email, admin: false }; records.set(input.username, record); return record },
    }
    const onboarding = new CommunityOnboarding(accounts, { verify: () => false, consume: () => {} })
    const input = { username: 'member', email: 'member@example.test', password: 'member-password' }
    await onboarding.createMember('admin', input)
    expect(onboarding.list('admin').map(account => account.username)).toEqual(['admin', 'member'])
    await expect(onboarding.createMember('member', { ...input, username: 'intruder' })).rejects.toMatchObject({ kind: 'forbidden' })
    records.set('admin', { ...admin, admin: false })
    expect(() => onboarding.list('admin')).toThrow()
    records.set('admin', { ...admin, disabled: true })
    await expect(onboarding.createMember('admin', { ...input, username: 'intruder' })).rejects.toMatchObject({ kind: 'forbidden' })
    expect(onboarding.activeUsernames()).toEqual(new Set(['member']))
  })

  it('requires the outstanding invitation and consumes it only after durable first-admin creation', async () => {
    let complete = false
    let invitation = 'fixture-invitation'
    let record: CommunityAccountRecord | undefined
    let rejectCreation = true
    const accounts: CommunityAccountOnboardingStorePort = {
      get: () => record, getState: () => record, list: () => record === undefined ? [] : [record],
      bootstrapComplete: () => complete, authenticate: async () => record,
      create: async () => { throw new Error('Member creation is outside bootstrap') },
      createFirstAdmin: async () => {
        if (rejectCreation) throw new Error('storage unavailable')
        complete = true; record = admin; return record
      },
    }
    const onboarding = new CommunityOnboarding(accounts, { verify: value => invitation !== '' && value === invitation, consume: () => { invitation = '' } })
    const input = { username: admin.username, email: admin.email, password: 'password' }
    await expect(onboarding.bootstrap('wrong', input)).rejects.toMatchObject({ kind: 'forbidden' })
    expect(accounts.list()).toEqual([])
    await expect(onboarding.bootstrap(invitation, input)).rejects.toThrow('storage unavailable')
    expect(invitation).toBe('fixture-invitation')
    rejectCreation = false
    await onboarding.bootstrap(invitation, input)
    expect(accounts.get('admin')?.admin).toBe(true)
    expect(invitation).toBe('')
    await expect(onboarding.bootstrap('fixture-invitation', input)).rejects.toMatchObject({ kind: 'missing' })
  })
})
