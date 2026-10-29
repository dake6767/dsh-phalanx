import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PostgresCommunityAccountStore } from '../src/adapters/postgres-community-accounts.js'
import { PlatformDatabase } from '../src/adapters/platform-database.js'
import { FilePlatformSecrets } from '../src/adapters/platform-secrets.js'
import type { PlatformDatabaseConnection } from '../src/domain/platform-database.js'
import { postgresConnection } from './support/postgres.js'

describe('community account persistence on PostgreSQL', () => {
  let root: string | undefined, connection: PlatformDatabaseConnection | undefined
  let security: ConstructorParameters<typeof PlatformDatabase>[1] | undefined
  const databases = new Map<PostgresCommunityAccountStore, PlatformDatabase>()
  afterEach(async () => {
    await Promise.all([...databases.values()].map(database => database.close()))
    databases.clear()
    if (root !== undefined) await rm(root, { recursive: true, force: true })
    root = undefined
    connection = undefined
    security = undefined
  })
  const close = async (store: PostgresCommunityAccountStore): Promise<void> => {
    await databases.get(store)!.close()
  }
  const open = async (): Promise<PostgresCommunityAccountStore> => {
    root ??= await mkdtemp(join(tmpdir(), 'community-postgres-accounts-'))
    connection ??= postgresConnection()
    if (!security) {
      const masterKeyPath = join(root, 'master.key'),
        secrets = FilePlatformSecrets.create(masterKeyPath)
      security = { masterKeyPath, registry: secrets.registry() }
      secrets.close()
    }
    const database = new PlatformDatabase(connection, security)
    await database.initialize()
    const store = new PostgresCommunityAccountStore(database)
    databases.set(store, database)
    return store
  }

  it('reclaims a partially registered admission when its final registration fails', async () => {
    const store = await open()
    await store.create({ username: 'member', email: '', password: 'password' })
    const connections = new Set<string>()
    await expect(
      store.withCurrentState('member', (account, onAbort) => {
        if (account?.disabled !== false) throw Error('Member admission was denied')
        onAbort(() => {
          connections.delete(account.username)
        })
        connections.add(account.username)
        throw Error('Connection registration failed')
      }),
    ).rejects.toThrow('Connection registration failed')
    expect(connections.size).toBe(0)
  })

  it('assigns exactly one group and changes the default only for future accounts', async () => {
    const store = await open()
    const initial = (await store.listGroups()).find(group => group.isDefault)!
    const first = await store.create({ username: 'first', email: '', password: 'password' })
    const team = await store.createGroup('Research')
    await store.setDefaultGroup(team.id)
    const second = await store.create({ username: 'second', email: '', password: 'password' })
    expect(first.groupId).toBe(initial.id)
    expect((await store.get('first'))?.groupId).toBe(initial.id)
    expect(second.groupId).toBe(team.id)
    expect((await store.listGroups()).find(group => group.id === team.id)).toMatchObject({ memberCount: 1, isDefault: true })
    await close(store)
    expect((await (await open()).get('first'))?.groupId).toBe(initial.id)
  })

  it('validates both account detail fields before committing either change', async () => {
    const store = await open()
    await store.createFirstAdmin({ username: 'admin', email: 'admin@example.test', password: 'password' })
    await store.create({ username: 'member', email: 'member@example.test', password: 'password' })
    const before = (await store.get('member'))!
    await expect(store.setAccountDetails('member', 'changed@example.test', 'admin')).rejects.toMatchObject({ code: 'group-role-conflict' })
    expect(await store.get('member')).toEqual(before)
    const group = await store.createGroup('Team')
    await expect(store.setAccountDetails('member', 'ADMIN@example.test', group.id)).rejects.toMatchObject({ code: 'email-in-use' })
    expect(await store.get('member')).toEqual(before)
    const changed = await store.setAccountDetails('member', 'changed@example.test', group.id)
    expect(changed).toMatchObject({ email: 'changed@example.test', groupId: group.id, spaceId: before.spaceId, sessionEpoch: before.sessionEpoch })
  })

  it('protects the default, administrator and populated groups and moves roles atomically', async () => {
    const store = await open()
    const admin = await store.createFirstAdmin({ username: 'admin', email: '', password: 'password' })
    const member = await store.create({ username: 'member', email: '', password: 'password' })
    const ordinary = (await store.listGroups()).find(group => group.isDefault)!
    const privileged = (await store.listGroups()).find(group => group.kind === 'admin')!
    expect(admin.groupId).toBe(privileged.id)
    await expect(store.deleteGroup(ordinary.id)).rejects.toThrowError(expect.objectContaining({ code: 'group-protected' }))
    await expect(store.deleteGroup(privileged.id)).rejects.toThrowError(expect.objectContaining({ code: 'group-protected' }))
    await expect(store.setDefaultGroup(privileged.id)).rejects.toThrowError(expect.objectContaining({ code: 'group-protected' }))
    await expect(store.setDefaultGroup('missing')).rejects.toThrowError(expect.objectContaining({ code: 'group-not-found' }))
    expect((await store.listGroups()).filter(group => group.isDefault)).toHaveLength(1)
    await expect(store.setAccountDetails(member.username, (await store.get(member.username))!.email, privileged.id)).rejects.toMatchObject({
      code: 'group-role-conflict',
    })
    await expect(store.create({ username: 'invalid', email: '', password: 'password', groupId: privileged.id })).rejects.toMatchObject({
      code: 'group-role-conflict',
    })
    await store.setAdmin(member.username, true)
    expect((await store.get(member.username))?.groupId).toBe(privileged.id)
    await expect(store.setAdmin(member.username, false)).rejects.toMatchObject({ code: 'group-required' })
    const team = await store.createGroup('Research')
    await store.setAdmin(member.username, false, team.id)
    expect(await store.get(member.username)).toMatchObject({ groupId: team.id, admin: false })
    await expect(store.deleteGroup(team.id)).rejects.toThrowError(expect.objectContaining({ code: 'group-has-members' }))
    await expect(store.setAdmin(admin.username, false, ordinary.id)).rejects.toMatchObject({ code: 'last-admin-required' })
    await store.setAccountDetails(member.username, (await store.get(member.username))!.email, ordinary.id)
    await store.renameGroup(team.id, 'Archive')
    await store.deleteGroup(team.id)
    expect((await store.listGroups()).some(group => group.id === team.id)).toBe(false)
  })

  it('persists a single admin and a member without retaining credentials in public account facts', async () => {
    const store = await open()
    await store.createFirstAdmin({ username: 'admin', email: 'admin@example.test', password: 'admin-password' })
    const member = await store.create({ username: 'member', email: 'member@example.test', password: 'member-password' })
    expect(member.admin).toBe(false)
    expect(Object.keys(member).sort()).toEqual(['admin', 'createdAt', 'disabled', 'email', 'groupId', 'sessionEpoch', 'spaceId', 'updatedAt', 'username'])
    await close(store)
    const reopened = await open()
    expect((await reopened.get('admin'))?.admin).toBe(true)
    expect(await reopened.authenticate('member', 'member-password')).toEqual(member)
    expect(await reopened.get('MeMbEr')).toEqual(member)
    expect(await reopened.authenticate('MEMBER', 'member-password')).toEqual(member)
    await expect(reopened.create({ username: 'member', email: 'other@example.test', password: 'password' })).rejects.toMatchObject({ code: 'username-in-use' })
    await expect(reopened.create({ username: 'MEMBER', email: 'other@example.test', password: 'password' })).rejects.toMatchObject({ code: 'username-invalid' })
    expect((await reopened.list()).map(account => account.username)).toEqual(['admin', 'member'])
    expect(await reopened.authenticate('member', 'wrong-password')).toBeUndefined()
    expect(await reopened.authenticate('unknown', 'member-password')).toBeUndefined()
    await expect(reopened.createFirstAdmin({ username: 'other', email: 'other@example.test', password: 'password' })).rejects.toMatchObject({
      kind: 'conflict',
    })
  })

  it('allows exactly one first admin when two store clients submit bootstrap concurrently', async () => {
    const first = await open()
    const second = await open()
    const results = await Promise.allSettled([
      first.createFirstAdmin({ username: 'first', email: 'first@example.test', password: 'password' }),
      second.createFirstAdmin({ username: 'second', email: 'second@example.test', password: 'password' }),
    ])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.find(result => result.status === 'rejected')).toMatchObject({ reason: { kind: 'conflict' } })
    expect(await first.list()).toHaveLength(1)
    expect(await first.bootstrapComplete()).toBe(true)
    await close(second)
    await close(first)
    expect((await (await open()).list()).map(account => account.admin)).toEqual([true])
  })

  it('resets every old session epoch and enabling never restores a revoked epoch', async () => {
    const store = await open()
    await store.createFirstAdmin({ username: 'admin', email: 'admin@example.test', password: 'password' })
    await store.create({ username: 'member', email: 'member@example.test', password: 'old-password' })
    await store.resetPassword('member', 'new-password')
    expect((await store.getState('member'))?.sessionEpoch).toBe(1)
    expect(await store.authenticate('member', 'old-password')).toBeUndefined()
    expect((await store.authenticate('member', 'new-password'))?.username).toBe('member')
    await store.setDisabled('member', true)
    expect(await store.authenticate('member', 'new-password')).toBeUndefined()
    await store.setDisabled('member', false)
    expect(await store.getState('member')).toMatchObject({ disabled: false, sessionEpoch: 2 })
    expect((await store.authenticate('member', 'new-password'))?.sessionEpoch).toBe(2)
  })

  it('atomically protects the last enabled admin, including competing role removals', async () => {
    const first = await open()
    await first.createFirstAdmin({ username: 'admin', email: 'admin@example.test', password: 'password' })
    await expect(first.setDisabled('admin', true)).rejects.toMatchObject({ kind: 'conflict' })
    await expect(first.setAdmin('admin', false, (await first.listGroups()).find(group => group.isDefault)!.id)).rejects.toMatchObject({ kind: 'conflict' })
    await first.create({ username: 'other', email: 'other@example.test', password: 'password' })
    await first.setAdmin('other', true)
    const second = await open()
    const defaultGroupId = (await first.listGroups()).find(group => group.isDefault)!.id
    const results = await Promise.allSettled([first.setAdmin('admin', false, defaultGroupId), second.setAdmin('other', false, defaultGroupId)])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.find(result => result.status === 'rejected')).toMatchObject({ reason: { kind: 'conflict' } })
    expect((await first.list()).filter(account => account.admin && !account.disabled)).toHaveLength(1)
  })

  it('preserves retired spaces while recreating an account with a fresh identity', async () => {
    const store = await open()
    await store.createFirstAdmin({ username: 'admin', email: 'admin@example.test', password: 'password' })
    const original = await store.create({ username: 'member', email: 'member@example.test', password: 'password' })
    expect(await store.getSpace('member')).toEqual({ spaceId: original.spaceId, storageKey: 'member' })
    await expect(store.delete('admin')).rejects.toMatchObject({ kind: 'conflict' })
    await store.delete('member')
    expect(await store.getState('member')).toBeUndefined()
    expect(await store.authenticate('member', 'password')).toBeUndefined()
    await close(store)
    const reopened = await open()
    expect(await reopened.bootstrapComplete()).toBe(true)
    const replacement = await reopened.create({ username: 'member', email: 'new@example.test', password: 'new-password' })
    expect(replacement.spaceId).not.toBe(original.spaceId)
    expect(await reopened.getSpace('member')).toEqual({ spaceId: replacement.spaceId, storageKey: `_spaces/${replacement.spaceId}` })
    expect((await reopened.list()).map(account => account.username)).toEqual(['admin', 'member'])
  })

  it('rejects case-insensitive duplicate email and invalid member input without adding accounts', async () => {
    const store = await open()
    await store.createFirstAdmin({ username: 'admin', email: 'admin@example.test', password: 'password' })
    const input = { username: 'member', email: 'ADMIN@example.test', password: 'password' }
    await expect(store.create(input)).rejects.toMatchObject({ kind: 'conflict' })
    await expect(store.create({ ...input, username: '../member' })).rejects.toMatchObject({ kind: 'invalid' })
    await expect(store.create({ ...input, email: 'member@example.test', password: '' })).rejects.toMatchObject({ kind: 'invalid' })
    expect((await store.list()).map(account => account.username)).toEqual(['admin'])
  })
})
