import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { CommunityAccountStore } from '../src/adapters/community-account-store.js'
import { hashPassword } from '../src/domain/password.js'

describe('community account persistence', () => {
  let root: string | undefined
  const stores: CommunityAccountStore[] = []
  afterEach(async () => {
    for (const store of stores.splice(0)) store.close()
    if (root !== undefined) await rm(root, { recursive: true, force: true })
    root = undefined
  })
  const open = async (): Promise<CommunityAccountStore> => {
    root ??= await mkdtemp(join(tmpdir(), 'community-accounts-'))
    const store = new CommunityAccountStore(join(root, 'accounts.db'))
    stores.push(store)
    return store
  }

  it('assigns exactly one group and changes the default only for future accounts', async () => {
    const store = await open()
    const initial = store.listGroups().find(group => group.isDefault)!
    const first = await store.create({ username: 'first', email: '', password: 'password' })
    const team = store.createGroup('Research')
    store.setDefaultGroup(team.id)
    const second = await store.create({ username: 'second', email: '', password: 'password' })
    expect(first.groupId).toBe(initial.id)
    expect(store.get('first')?.groupId).toBe(initial.id)
    expect(second.groupId).toBe(team.id)
    expect(store.listGroups().find(group => group.id === team.id)).toMatchObject({ memberCount: 1, isDefault: true })
    store.close()
    expect((await open()).get('first')?.groupId).toBe(initial.id)
  })

  it('validates both account detail fields before committing either change', async () => {
    const store = await open()
    await store.createFirstAdmin({ username: 'admin', email: 'admin@example.test', password: 'password' })
    await store.create({ username: 'member', email: 'member@example.test', password: 'password' })
    const before = store.get('member')!
    await expect(store.setAccountDetails('member', 'changed@example.test', 'admin')).rejects.toMatchObject({ code: 'group-role-conflict' })
    expect(store.get('member')).toEqual(before)
    const group = store.createGroup('Team')
    await expect(store.setAccountDetails('member', 'ADMIN@example.test', group.id)).rejects.toMatchObject({ code: 'email-in-use' })
    expect(store.get('member')).toEqual(before)
    const changed = await store.setAccountDetails('member', 'changed@example.test', group.id)
    expect(changed).toMatchObject({ email: 'changed@example.test', groupId: group.id, spaceId: before.spaceId, sessionEpoch: before.sessionEpoch })
  })

  it('protects the default, administrator and populated groups and moves roles atomically', async () => {
    const store = await open()
    const admin = await store.createFirstAdmin({ username: 'admin', email: '', password: 'password' })
    const member = await store.create({ username: 'member', email: '', password: 'password' })
    const ordinary = store.listGroups().find(group => group.isDefault)!
    const privileged = store.listGroups().find(group => group.kind === 'admin')!
    expect(admin.groupId).toBe(privileged.id)
    expect(() => store.deleteGroup(ordinary.id)).toThrowError(expect.objectContaining({ code: 'group-protected' }))
    expect(() => store.deleteGroup(privileged.id)).toThrowError(expect.objectContaining({ code: 'group-protected' }))
    expect(() => store.setDefaultGroup(privileged.id)).toThrowError(expect.objectContaining({ code: 'group-protected' }))
    expect(() => store.setDefaultGroup('missing')).toThrowError(expect.objectContaining({ code: 'group-not-found' }))
    expect(store.listGroups().filter(group => group.isDefault)).toHaveLength(1)
    await expect(store.setAccountDetails(member.username, store.get(member.username)!.email, privileged.id)).rejects.toMatchObject({ code: 'group-role-conflict' })
    await expect(store.create({ username: 'invalid', email: '', password: 'password', groupId: privileged.id })).rejects.toMatchObject({ code: 'group-role-conflict' })
    await store.setAdmin(member.username, true)
    expect(store.get(member.username)?.groupId).toBe(privileged.id)
    await expect(store.setAdmin(member.username, false)).rejects.toMatchObject({ code: 'group-required' })
    const team = store.createGroup('Research')
    await store.setAdmin(member.username, false, team.id)
    expect(store.get(member.username)).toMatchObject({ groupId: team.id, admin: false })
    expect(() => store.deleteGroup(team.id)).toThrowError(expect.objectContaining({ code: 'group-has-members' }))
    await expect(store.setAdmin(admin.username, false, ordinary.id)).rejects.toMatchObject({ code: 'last-admin-required' })
    await store.setAccountDetails(member.username, store.get(member.username)!.email, ordinary.id)
    store.renameGroup(team.id, 'Archive')
    store.deleteGroup(team.id)
    expect(store.listGroups().some(group => group.id === team.id)).toBe(false)
  })

  it('persists a single admin and a member without retaining credentials in public account facts', async () => {
    const store = await open()
    await store.createFirstAdmin({ username: 'admin', email: 'admin@example.test', password: 'admin-password' })
    const member = await store.create({ username: 'member', email: 'member@example.test', password: 'member-password' })
    expect(member.admin).toBe(false)
    expect(Object.keys(member).sort()).toEqual(['admin', 'createdAt', 'disabled', 'email', 'groupId', 'sessionEpoch', 'spaceId', 'updatedAt', 'username'])
    store.close()
    const reopened = await open()
    expect(reopened.get('admin')?.admin).toBe(true)
    expect(await reopened.authenticate('member', 'member-password')).toEqual(member)
    expect(await reopened.authenticate('member', 'wrong-password')).toBeUndefined()
    expect(await reopened.authenticate('unknown', 'member-password')).toBeUndefined()
    await expect(reopened.createFirstAdmin({ username: 'other', email: 'other@example.test', password: 'password' })).rejects.toMatchObject({ kind: 'conflict' })
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
    expect(first.list()).toHaveLength(1)
    expect(first.bootstrapComplete()).toBe(true)
    second.close(); first.close()
    expect((await open()).list().map(account => account.admin)).toEqual([true])
  })

  it('resets every old session epoch and enabling never restores a revoked epoch', async () => {
    const store = await open()
    await store.createFirstAdmin({ username: 'admin', email: 'admin@example.test', password: 'password' })
    await store.create({ username: 'member', email: 'member@example.test', password: 'old-password' })
    await store.resetPassword('member', 'new-password')
    expect(store.getState('member')?.sessionEpoch).toBe(1)
    expect(await store.authenticate('member', 'old-password')).toBeUndefined()
    expect((await store.authenticate('member', 'new-password'))?.username).toBe('member')
    await store.setDisabled('member', true)
    expect(await store.authenticate('member', 'new-password')).toBeUndefined()
    await store.setDisabled('member', false)
    expect(store.getState('member')).toMatchObject({ disabled: false, sessionEpoch: 2 })
    expect((await store.authenticate('member', 'new-password'))?.sessionEpoch).toBe(2)
  })

  it('atomically protects the last enabled admin, including competing role removals', async () => {
    const first = await open()
    await first.createFirstAdmin({ username: 'admin', email: 'admin@example.test', password: 'password' })
    await expect(first.setDisabled('admin', true)).rejects.toMatchObject({ kind: 'conflict' })
    await expect(first.setAdmin('admin', false, first.listGroups().find(group => group.isDefault)!.id)).rejects.toMatchObject({ kind: 'conflict' })
    await first.create({ username: 'other', email: 'other@example.test', password: 'password' })
    await first.setAdmin('other', true)
    const second = await open()
    const results = await Promise.allSettled([first.setAdmin('admin', false, first.listGroups().find(group => group.isDefault)!.id), second.setAdmin('other', false, second.listGroups().find(group => group.isDefault)!.id)])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.find(result => result.status === 'rejected')).toMatchObject({ reason: { kind: 'conflict' } })
    expect(first.list().filter(account => account.admin && !account.disabled)).toHaveLength(1)
  })

  it('preserves retired spaces while recreating an account with a fresh identity', async () => {
    const store = await open()
    await store.createFirstAdmin({ username: 'admin', email: 'admin@example.test', password: 'password' })
    await store.create({ username: 'member', email: 'member@example.test', password: 'password' })
    await expect(store.delete('admin')).rejects.toMatchObject({ kind: 'conflict' })
    await store.delete('member')
    expect(store.getState('member')).toBeUndefined()
    expect(await store.authenticate('member', 'password')).toBeUndefined()
    store.close()
    const reopened = await open()
    expect(reopened.bootstrapComplete()).toBe(true)
    const replacement = await reopened.create({ username: 'member', email: 'new@example.test', password: 'new-password' })
    expect(replacement.spaceId).toEqual(expect.any(String))
    expect(reopened.list().map(account => account.username)).toEqual(['admin', 'member'])
  })

  it('does not authenticate an account disabled while password verification is in flight', async () => {
    const store = await open()
    await store.createFirstAdmin({ username: 'admin', email: 'admin@example.test', password: 'password' })
    await store.create({ username: 'member', email: 'member@example.test', password: 'password' })
    const signingIn = store.authenticate('member', 'password')
    await store.setDisabled('member', true)
    expect(await signingIn).toBeUndefined()
  })

  it('upgrades the prior community schema without losing account access or reopening bootstrap', async () => {
    root = await mkdtemp(join(tmpdir(), 'community-accounts-'))
    const previous = new DatabaseSync(join(root, 'accounts.db'))
    const hash = await hashPassword('previous-password')
    previous.exec(`CREATE TABLE accounts (
      username TEXT PRIMARY KEY, email TEXT NOT NULL COLLATE NOCASE UNIQUE,
      password_hash TEXT NOT NULL, admin INTEGER NOT NULL CHECK (admin IN (0, 1)),
      disabled INTEGER NOT NULL DEFAULT 0 CHECK (disabled IN (0, 1)),
      session_epoch INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    ); CREATE TABLE bootstrap_state (id INTEGER PRIMARY KEY CHECK (id = 1), completed INTEGER NOT NULL);
    INSERT INTO bootstrap_state VALUES (1, 1); PRAGMA user_version = 1;`)
    previous.prepare('INSERT INTO accounts VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run('admin', 'admin@example.test', hash, 1, 0, 4, 1, 2)
    previous.prepare('INSERT INTO accounts VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run('prior-member', 'prior@example.test', hash, 0, 0, 2, 1, 2)
    previous.close()
    const store = await open()
    expect(store.bootstrapComplete()).toBe(true)
    expect(await store.authenticate('admin', 'previous-password')).toMatchObject({ username: 'admin', admin: true, sessionEpoch: 4 })
    expect(store.get('admin')?.groupId).toBe('admin')
    expect(store.get('prior-member')?.groupId).toBe('default')
    const group = store.createGroup('Migrated team')
    await store.setAccountDetails('prior-member', store.get('prior-member')!.email, group.id); store.setDefaultGroup(group.id)
    const before = store.list()
    store.close()
    const reopened = await open()
    expect(reopened.list()).toEqual(before)
    expect(reopened.listGroups().find(value => value.isDefault)?.id).toBe(group.id)
    reopened.close()
    expect(await (await open()).authenticate('admin', 'previous-password')).toMatchObject({ username: 'admin', sessionEpoch: 4 })
  })

  it('rejects case-insensitive duplicate email and invalid member input without adding accounts', async () => {
    const store = await open()
    await store.createFirstAdmin({ username: 'admin', email: 'admin@example.test', password: 'password' })
    const input = { username: 'member', email: 'ADMIN@example.test', password: 'password' }
    await expect(store.create(input)).rejects.toMatchObject({ kind: 'conflict' })
    await expect(store.create({ ...input, username: '../member' })).rejects.toMatchObject({ kind: 'invalid' })
    await expect(store.create({ ...input, email: 'member@example.test', password: '' })).rejects.toMatchObject({ kind: 'invalid' })
    expect(store.list().map(account => account.username)).toEqual(['admin'])
  })

  it('refuses to reinterpret a pre-existing non-community database', async () => {
    root = await mkdtemp(join(tmpdir(), 'community-accounts-'))
    const path = join(root, 'accounts.db')
    const legacy = new DatabaseSync(path)
    legacy.exec('CREATE TABLE accounts (username TEXT PRIMARY KEY, group_name TEXT)')
    legacy.close()
    expect(() => new CommunityAccountStore(path)).toThrow('require a fresh database')
    const unchanged = new DatabaseSync(path)
    try { expect(unchanged.prepare('PRAGMA table_info(accounts)').all().map(row => row.name)).toEqual(['username', 'group_name']) }
    finally { unchanged.close() }
  })
})
