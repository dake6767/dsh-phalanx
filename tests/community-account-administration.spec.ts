import { describe, expect, it } from 'vitest'
import { CommunityAccountAdministration } from '../src/use-cases/community-account-administration.js'
import type { CommunityAccountRecord } from '../src/domain/community-account.js'
import type { CommunityAccountStorePort } from '../src/ports/community-accounts.js'
import type { CommunityRuntimePort } from '../src/ports/community-runtime.js'

const account = (username: string, admin = false): CommunityAccountRecord => ({ username, spaceId: `space-${username}`, admin, groupId: admin ? 'admin' : 'default', email: `${username}@example.test`, disabled: false, sessionEpoch: 0, createdAt: 0, updatedAt: 0 })
function fixture() {
  const records = new Map([['admin', account('admin', true)], ['member', account('member')], ['other', account('other')]])
  const instances = new Set(['member', 'other'])
  const connected = new Set(['member-device-a', 'member-device-b', 'other-device'])
  const groups = new Map([['default', { id: 'default', name: 'Default', kind: 'ordinary' as const, isDefault: true, memberCount: 2 }], ['admin', { id: 'admin', name: 'Administrators', kind: 'admin' as const, isDefault: false, memberCount: 1 }]])
  const accounts: CommunityAccountStorePort = {
    listGroups: () => [...groups.values()],
    createGroup: name => { const group = { id: name, name, kind: 'ordinary' as const, isDefault: false, memberCount: 0 }; groups.set(name, group); return group },
    renameGroup: (id, name) => { const group = { ...groups.get(id)!, name }; groups.set(id, group); return group },
    deleteGroup: id => { groups.delete(id) },
    setDefaultGroup: id => { for (const group of groups.values()) groups.set(group.id, { ...group, isDefault: group.id === id }) },
    get: username => records.get(username), getState: username => records.get(username), list: () => [...records.values()],
    bootstrapComplete: () => true, authenticate: async username => records.get(username), createFirstAdmin: async () => records.get('admin')!,
    create: async input => { const created = { ...account(input.username), groupId: input.groupId ?? 'default' }; records.set(created.username, created); return created },
    resetPassword: async username => { const current = records.get(username)!; records.set(username, { ...current, sessionEpoch: current.sessionEpoch + 1 }) },
    setDisabled: async (username, disabled) => { const current = records.get(username)!; const updated = { ...current, disabled, sessionEpoch: current.sessionEpoch + (disabled && !current.disabled ? 1 : 0) }; records.set(username, updated); return updated },
    setAccountDetails: async (username, email, groupId) => { const updated = { ...records.get(username)!, email, groupId: groupId ?? records.get(username)!.groupId }; records.set(username, updated); return updated },
    setAdmin: async (username, admin, groupId) => { const updated = { ...records.get(username)!, admin, groupId: admin ? 'admin' : groupId! }; records.set(username, updated); return updated },
    delete: async username => { records.delete(username) },
  }
  const runtime: CommunityRuntimePort = { ensure: async () => { throw new Error('Not used') }, status: () => ({ state: 'stopped' }),
    recover: async () => { throw new Error('Unexpected recovery') }, restart: async () => { throw new Error('Not used') }, reclaim: async () => 'not-running', terminate: async username => { instances.delete(username) }, stopAll: async () => {},
    reconcileStartupContainers: async () => ({ adopted: [], swept: [] }) }
  const connections = { closeUser: async (username: string) => { for (const device of connected) if (device.startsWith(`${username}-`)) connected.delete(device) } }
  return { records, instances, connected, accounts, runtime, connections,
    administration: new CommunityAccountAdministration(accounts, runtime, connections) }
}

describe('community account administration', () => {
  it('manages groups with current administrator authority and protects populated/default groups', async () => {
    const world = fixture()
    const actor = { username: 'admin', spaceId: 'space-admin', sessionEpoch: 0 }
    const ordinary = await world.administration.manageGroup(actor, { action: 'create', name: 'Research' })
    expect(ordinary.find(group => group.name === 'Research')).toBeDefined()
    await expect(world.administration.manageGroup(actor, { action: 'delete', id: 'default' })).rejects.toMatchObject({ code: 'group-protected' })
    await expect(world.administration.manageGroup(actor, { action: 'set-default', id: 'admin', confirmed: true })).rejects.toMatchObject({ code: 'group-protected' })
    await world.administration.manageGroup(actor, { action: 'set-default', id: 'Research', confirmed: true })
    await expect(world.administration.manageGroup(actor, { action: 'delete', id: 'default' })).rejects.toMatchObject({ code: 'group-has-members' })
    await expect(world.administration.manageGroup(actor, { action: 'create', name: 'Research' })).rejects.toMatchObject({ code: 'group-name-in-use' })
    await world.administration.manageGroup(actor, { action: 'rename', id: 'Research', name: 'Lab' })
    expect(world.administration.listGroups(actor).find(group => group.id === 'Research')?.name).toBe('Lab')
    world.records.set('admin', { ...world.records.get('admin')!, admin: false })
    await expect(world.administration.manageGroup(actor, { action: 'create', name: 'Denied' })).rejects.toMatchObject({ code: 'admin-required' })
  })

  it('validates membership and role changes before invoking persistence, retaining running instances', async () => {
    const world = fixture()
    const actor = { username: 'admin', spaceId: 'space-admin', sessionEpoch: 0 }
    await expect(world.administration.createMember(actor, { username: 'new', email: 'new@example.test', password: 'password', groupId: 'admin' })).rejects.toMatchObject({ code: 'group-role-conflict' })
    expect(world.records.has('new')).toBe(false)
    await expect(world.administration.execute(actor, 'member', { action: 'set-email', email: 'changed@example.test', groupId: 'admin' })).rejects.toMatchObject({ code: 'group-role-conflict' })
    expect(world.records.get('member')?.email).toBe('member@example.test')
    await world.administration.execute(actor, 'member', { action: 'set-admin', admin: true })
    expect(world.records.get('member')).toMatchObject({ admin: true, groupId: 'admin' })
    await expect(world.administration.execute(actor, 'member', { action: 'set-admin', admin: false })).rejects.toMatchObject({ code: 'group-required' })
    await expect(world.administration.execute(actor, 'member', { action: 'set-admin', admin: false, groupId: 'admin' })).rejects.toMatchObject({ code: 'group-role-conflict' })
    await world.administration.execute(actor, 'member', { action: 'set-admin', admin: false, groupId: 'default' })
    expect(world.records.get('member')).toMatchObject({ admin: false, groupId: 'default' })
    await expect(world.administration.execute(actor, 'admin', { action: 'set-admin', admin: false, groupId: 'default' })).rejects.toMatchObject({ code: 'last-admin-required' })
    expect(world.instances).toEqual(new Set(['member', 'other']))
    expect(world.connected.size).toBe(3)
  })

  it('changes only the contact email and retains all connections and instances', async () => {
    const world = fixture(); const before = world.accounts.get('member')!
    const updated = await world.administration.execute({ username: 'admin', spaceId: 'space-admin', sessionEpoch: 0 }, 'member', { action: 'set-email', email: 'changed@example.test' })
    expect(updated).toEqual({ ...before, email: 'changed@example.test' })
    expect(world.connected).toEqual(new Set(['member-device-a', 'member-device-b', 'other-device']))
    expect(world.instances).toEqual(new Set(['member', 'other']))
  })

  it('revokes every device on password reset, retaining that instance and another user', async () => {
    const world = fixture()
    await expect(world.administration.execute({ username: 'member', spaceId: 'space-member', sessionEpoch: 0 }, 'admin', { action: 'reset-password', password: 'new-password' })).rejects.toMatchObject({ kind: 'forbidden', code: 'admin-required' })
    await world.administration.execute({ username: 'admin', spaceId: 'space-admin', sessionEpoch: 0 }, 'member', { action: 'reset-password', password: 'new-password' })
    expect(world.accounts.getState('member')?.sessionEpoch).toBe(1)
    expect(world.connected).toEqual(new Set(['other-device']))
    expect(world.instances).toEqual(new Set(['member', 'other']))
  })

  it('denies access before stopping an instance and does not disturb another user', async () => {
    const world = fixture()
    let entered!: () => void
    let release!: () => void
    const stopping = new Promise<void>(resolve => { entered = resolve })
    const stopped = new Promise<void>(resolve => { release = resolve })
    world.runtime.terminate = async username => { entered(); await stopped; world.instances.delete(username) }
    const disable = world.administration.execute({ username: 'admin', spaceId: 'space-admin', sessionEpoch: 0 }, 'member', { action: 'set-disabled', disabled: true })
    expect(await Promise.race([stopping.then(() => 'stopping'), disable.then(() => 'completed')])).toBe('stopping')
    expect(world.accounts.getState('member')).toMatchObject({ disabled: true, sessionEpoch: 1 })
    expect(world.connected).toEqual(new Set(['other-device']))
    expect(world.instances).toEqual(new Set(['member', 'other']))
    release()
    await disable
    expect(world.instances).toEqual(new Set(['other']))
  })

  it('rechecks the administrator when a queued action follows an unfinished disable', async () => {
    const world = fixture()
    let entered!: () => void
    let release!: () => void
    const stopping = new Promise<void>(resolve => { entered = resolve })
    const stopped = new Promise<void>(resolve => { release = resolve })
    world.runtime.terminate = async username => { entered(); await stopped; world.instances.delete(username) }
    const disable = world.administration.execute({ username: 'admin', spaceId: 'space-admin', sessionEpoch: 0 }, 'member', { action: 'set-disabled', disabled: true })
    expect(await Promise.race([stopping.then(() => 'stopping'), disable.then(() => 'completed')])).toBe('stopping')
    const enable = world.administration.execute({ username: 'admin', spaceId: 'space-admin', sessionEpoch: 0 }, 'member', { action: 'set-disabled', disabled: false })
    const refused = expect(enable).rejects.toMatchObject({ kind: 'forbidden', code: 'admin-required' })
    world.records.set('admin', { ...world.records.get('admin')!, admin: false })
    release()
    await disable
    await refused
    expect(world.accounts.getState('member')?.disabled).toBe(true)
  })

  it('keeps an account disabled after a failed stop and permits a deletion retry', async () => {
    const world = fixture()
    world.runtime.terminate = async () => { throw new Error('fixture transport failure') }
    await expect(world.administration.execute({ username: 'admin', spaceId: 'space-admin', sessionEpoch: 0 }, 'member', { action: 'set-disabled', disabled: true })).rejects.toMatchObject({ reason: 'instance-stop-failed', code: 'account-stop-failed', params: { action: 'disable' } })
    expect(world.accounts.getState('member')?.disabled).toBe(true)
    expect(world.connected).toEqual(new Set(['other-device']))
    await expect(world.administration.execute({ username: 'admin', spaceId: 'space-admin', sessionEpoch: 0 }, 'member', { action: 'set-disabled', disabled: false })).rejects.toMatchObject({ reason: 'instance-stop-failed' })
    expect(world.accounts.getState('member')?.disabled).toBe(true)
    await expect(world.administration.execute({ username: 'admin', spaceId: 'space-admin', sessionEpoch: 0 }, 'member', { action: 'delete' })).rejects.toMatchObject({ reason: 'instance-stop-failed' })
    expect(world.accounts.get('member')).toBeDefined()
    world.runtime.terminate = async username => { world.instances.delete(username) }
    await world.administration.execute({ username: 'admin', spaceId: 'space-admin', sessionEpoch: 0 }, 'member', { action: 'delete' })
    expect(world.accounts.getState('member')).toBeUndefined()
    expect(world.instances).toEqual(new Set(['other']))
  })

  it('refuses an already-admitted administrator request after that login epoch is revoked', async () => {
    const world = fixture()
    const admitted = { username: 'admin', spaceId: 'space-admin', sessionEpoch: 0 }
    const operation = world.administration.execute(admitted, 'other', { action: 'set-admin', admin: true })
    world.records.set('admin', { ...world.records.get('admin')!, sessionEpoch: 1 })
    await expect(operation).rejects.toThrow('Sign in is required')
    expect(world.accounts.get('other')?.admin).toBe(false)
  })
})
