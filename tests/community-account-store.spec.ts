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

  it('persists a single admin and a member without retaining credentials in public account facts', async () => {
    const store = await open()
    await store.createFirstAdmin({ username: 'admin', email: 'admin@example.test', password: 'admin-password' })
    const member = await store.create({ username: 'member', email: 'member@example.test', password: 'member-password' })
    expect(member.admin).toBe(false)
    expect(Object.keys(member).sort()).toEqual(['admin', 'createdAt', 'disabled', 'email', 'sessionEpoch', 'spaceId', 'updatedAt', 'username'])
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
    await expect(first.setAdmin('admin', false)).rejects.toMatchObject({ kind: 'conflict' })
    await first.create({ username: 'other', email: 'other@example.test', password: 'password' })
    await first.setAdmin('other', true)
    const second = await open()
    const results = await Promise.allSettled([first.setAdmin('admin', false), second.setAdmin('other', false)])
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
    previous.close()
    const store = await open()
    expect(store.bootstrapComplete()).toBe(true)
    expect(await store.authenticate('admin', 'previous-password')).toMatchObject({ username: 'admin', admin: true, sessionEpoch: 4 })
    await store.create({ username: 'member', email: 'member@example.test', password: 'password' })
    await store.delete('member'); store.close()
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
