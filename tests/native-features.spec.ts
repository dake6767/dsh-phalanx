import { expect, it } from 'vitest'
import { BusinessRuleError } from '../src/domain/business-error.js'
import { nativeFeatureCatalog } from '../src/domain/native-features.js'
import type { CommunityAccountActor } from '../src/domain/community-account.js'
import type { NativeFeatureGroupState, NativeFeaturePersistence, NativeFeatureRows } from '../src/ports/native-features.js'
import { NativeFeatures } from '../src/use-cases/native-features.js'

function fixture() {
  const groups = new Set(['admin', 'team', 'other'])
  const settings = new Map<string, NativeFeatureGroupState>()
  const members = new Map([
    ['admin', { spaceId: 'a'.repeat(32), groupId: 'admin' }],
    ['member', { spaceId: 'b'.repeat(32), groupId: 'team' }],
  ])
  let revision = 0
  let administrator = true
  const actor: CommunityAccountActor = { username: 'admin', spaceId: 'a'.repeat(32), sessionEpoch: 0 }
  const rows: NativeFeatureRows = {
    readGroup: async groupId => (groups.has(groupId) ? structuredClone(settings.get(groupId) ?? { groupId, revision: 'none', disabledIds: [] }) : undefined),
    forMember: async member => {
      const account = members.get(member.username)
      return account?.spaceId === member.spaceId ? rows.readGroup(account.groupId) : undefined
    },
    save: async (groupId, disabledIds, expectedRevision) => {
      if (!groups.has(groupId) || (settings.get(groupId)?.revision ?? 'none') !== expectedRevision)
        throw new BusinessRuleError('conflict', 'Changed', 'native-features-stale')
      const saved = { groupId, disabledIds: [...disabledIds], revision: 'revision-' + ++revision }
      settings.set(groupId, saved)
      return saved
    },
  }
  const persistence: NativeFeaturePersistence = {
    rows,
    work: {
      run: async operation =>
        operation({
          features: rows,
          actors: {
            lockAdministrator: async () => {
              if (!administrator) throw new BusinessRuleError('forbidden', 'Administrator required', 'admin-required')
            },
          },
        }),
    },
  }
  const service = new NativeFeatures(nativeFeatureCatalog(), persistence)
  return {
    service,
    actor,
    rows,
    persistence,
    groups,
    settings,
    members,
    revoke: () => {
      administrator = false
    },
  }
}

it('defaults every group and member to all features, including administrators', async () => {
  const world = fixture()
  for (const group of ['admin', 'team']) {
    expect((await world.service.group(world.actor, group)).features.every(feature => feature.enabled)).toBe(true)
  }
  for (const [username, member] of world.members) expect(await world.service.resolve({ username, spaceId: member.spaceId })).toEqual({ disabledIds: [] })
})

it('rechecks administrator authority before reading or saving any group state', async () => {
  const world = fixture()
  world.revoke()
  await expect(world.service.group(world.actor, 'team')).rejects.toMatchObject({ code: 'admin-required' })
  await expect(world.service.save(world.actor, 'team', { revision: 'invalid', disabledIds: ['terminal'] })).rejects.toMatchObject({ code: 'admin-required' })
  expect(world.settings.size).toBe(0)
})

it('keeps unknown stored choices while returning only supported restrictions to a member', async () => {
  const world = fixture()
  world.settings.set('team', { groupId: 'team', revision: 'existing', disabledIds: ['future-feature'] })
  const view = await world.service.group(world.actor, 'team')
  await world.service.save(world.actor, 'team', { revision: view.revision, disabledIds: ['terminal'] })
  expect(world.settings.get('team')?.disabledIds).toEqual(['future-feature', 'terminal'])
  expect(await world.service.resolve({ username: 'member', spaceId: 'b'.repeat(32) })).toEqual({ disabledIds: ['terminal'] })
})

it('accepts only one competing edit and leaves other groups independent', async () => {
  const world = fixture()
  const view = await world.service.group(world.actor, 'team')
  const results = await Promise.allSettled([
    world.service.save(world.actor, 'team', { revision: view.revision, disabledIds: ['terminal'] }),
    world.service.save(world.actor, 'team', { revision: view.revision, disabledIds: [] }),
  ])
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
  expect(results.find(result => result.status === 'rejected')).toMatchObject({ reason: { code: 'native-features-stale' } })
  await expect(world.service.save(world.actor, 'team', { revision: view.revision, disabledIds: [] })).rejects.toMatchObject({ code: 'native-features-stale' })
  const other = await world.service.group(world.actor, 'other')
  await expect(world.service.save(world.actor, 'other', { revision: other.revision, disabledIds: ['terminal'] })).resolves.toHaveProperty('groupId', 'other')
})

it('refuses missing owners and stale member-space identities instead of assuming default access', async () => {
  const world = fixture()
  await expect(world.service.group(world.actor, 'missing')).rejects.toMatchObject({ code: 'group-not-found' })
  await expect(world.service.save(world.actor, 'missing', { revision: 'none', disabledIds: [] })).rejects.toMatchObject({ code: 'group-not-found' })
  await expect(world.service.resolve({ username: 'member', spaceId: 'stale' })).rejects.toMatchObject({ code: 'account-inactive' })
})

it('refuses an old catalog form rather than clearing a previously unknown selection after a build adds that feature', async () => {
  const world = fixture()
  world.settings.set('team', { groupId: 'team', revision: 'stored-revision', disabledIds: ['future-feature'] })
  const oldForm = await world.service.group(world.actor, 'team')
  expect(oldForm.features.some(feature => feature.id === 'future-feature')).toBe(false)
  const current = new NativeFeatures(nativeFeatureCatalog([{ ...nativeFeatureCatalog()[0]!, id: 'future-feature' }]), world.persistence)
  await expect(current.save(world.actor, 'team', { revision: oldForm.revision, disabledIds: [] })).rejects.toMatchObject({ code: 'native-features-stale' })
  expect(world.settings.get('team')?.disabledIds).toEqual(['future-feature'])
})

it('persists group choices for the next resolution without exempting administrators or caching membership', async () => {
  const world = fixture()
  for (const groupId of ['team', 'admin']) {
    const initial = await world.service.group(world.actor, groupId)
    const saved = await world.service.save(world.actor, groupId, { revision: initial.revision, disabledIds: ['terminal'] })
    expect(saved.features.find(feature => feature.id === 'terminal')?.enabled).toBe(false)
  }
  for (const [username, member] of world.members)
    expect(await world.service.resolve({ username, spaceId: member.spaceId })).toEqual({ disabledIds: ['terminal'] })
  const member = world.members.get('member')!
  member.groupId = 'other'
  expect(await world.service.resolve({ username: 'member', spaceId: member.spaceId })).toEqual({ disabledIds: [] })
})
