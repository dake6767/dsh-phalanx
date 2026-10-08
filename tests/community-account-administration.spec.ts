import { describe, expect, it } from 'vitest'
import { CommunityAccountAdministration } from '../src/use-cases/community-account-administration.js'
import type { CommunityAccountRecord } from '../src/domain/community-account.js'
import type { CommunityAccountStorePort } from '../src/ports/community-accounts.js'
import type { CommunityRuntimePort } from '../src/ports/community-runtime.js'

const account = (username: string, admin = false): CommunityAccountRecord => ({ username, spaceId: `space-${username}`, admin, email: `${username}@example.test`, disabled: false, sessionEpoch: 0, createdAt: 0, updatedAt: 0 })
function fixture() {
  const records = new Map([['admin', account('admin', true)], ['member', account('member')], ['other', account('other')]])
  const instances = new Set(['member', 'other'])
  const connected = new Set(['member-device-a', 'member-device-b', 'other-device'])
  const accounts: CommunityAccountStorePort = {
    get: username => records.get(username), getState: username => records.get(username), list: () => [...records.values()],
    bootstrapComplete: () => true, authenticate: async username => records.get(username), createFirstAdmin: async () => records.get('admin')!,
    create: async input => { const created = account(input.username); records.set(created.username, created); return created },
    resetPassword: async username => { const current = records.get(username)!; records.set(username, { ...current, sessionEpoch: current.sessionEpoch + 1 }) },
    setDisabled: async (username, disabled) => { const current = records.get(username)!; const updated = { ...current, disabled, sessionEpoch: current.sessionEpoch + (disabled && !current.disabled ? 1 : 0) }; records.set(username, updated); return updated },
    setEmail: async (username, email) => { const updated = { ...records.get(username)!, email }; records.set(username, updated); return updated },
    setAdmin: async (username, admin) => { const updated = { ...records.get(username)!, admin }; records.set(username, updated); return updated },
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
