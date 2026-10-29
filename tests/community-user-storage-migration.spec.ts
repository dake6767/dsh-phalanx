import { expect, it } from 'vitest'
import { CommunityUserStorageMigration } from '../src/use-cases/community-user-storage-migration.js'
import { chmod, mkdir, mkdtemp, readFile, readlink, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { copyUserStorage, userStorageInventory } from '../src/adapters/user-storage-copy.js'

it('stops owned carriers, copies and verifies before publishing a storage switch, and releases the maintenance lock on failure', async () => {
  const events: string[] = []
  let failure = false
  const result = { sourceRoot: '/old/users', targetRoot: '/mnt/data/users', targetMount: '/mnt/data', recovery: '/private/storage-migration/README.txt' }
  const migration = new CommunityUserStorageMigration({
    prepare: async () => {
      events.push('lock')
      return { state: 'pending' }
    },
    stopCarriers: async () => {
      events.push('stop')
    },
    copy: async () => {
      events.push('copy')
    },
    verify: async () => {
      events.push('verify')
      if (failure) throw new Error('fixture verification mismatch')
    },
    publish: async () => {
      events.push('publish')
      return result
    },
    rollback: async () => {
      throw new Error('Unexpected rollback')
    },
    close: async () => {
      events.push('unlock')
    },
  })
  expect(await migration.migrate('/mnt/data/users', '/mnt/data')).toEqual(result)
  expect(events).toEqual(['lock', 'stop', 'copy', 'verify', 'publish', 'unlock'])
  events.length = 0
  failure = true
  await expect(migration.migrate('/mnt/data/users', '/mnt/data')).rejects.toThrow()
  expect(events).toEqual(['lock', 'stop', 'copy', 'verify', 'unlock'])
})

it('copies real private directories and link text without following links, and verification detects changed bytes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'storage-copy-'))
  try {
    const source = join(root, 'source'),
      target = join(root, 'target')
    await mkdir(join(source, 'nested'), { recursive: true, mode: 0o700 })
    await chmod(source, 0o700)
    await writeFile(join(source, 'nested/data'), Buffer.alloc(2 * 1024 * 1024 + 17, 0x61), { mode: 0o600 })
    await writeFile(join(root, 'outside'), 'outside-retained', { mode: 0o600 })
    await symlink('../../outside', join(source, 'nested/link'))
    copyUserStorage(source, target)
    expect((await stat(target)).mode & 0o777).toBe(0o700)
    expect((await stat(join(target, 'nested'))).mode & 0o777).toBe(0o700)
    expect(await readlink(join(target, 'nested/link'))).toBe('../../outside')
    expect(userStorageInventory(target)).toBe(userStorageInventory(source))
    await writeFile(join(target, 'nested/data'), 'changed')
    expect(userStorageInventory(target)).not.toBe(userStorageInventory(source))
    expect(await readFile(join(root, 'outside'), 'utf8')).toBe('outside-retained')
    expect((await stat(join(source, 'nested/data'))).size).toBe(2 * 1024 * 1024 + 17)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('keeps completed migration data untouched on retry and still releases the lock', async () => {
  const events: string[] = []
  const result = { sourceRoot: '/old/users', targetRoot: '/mnt/data/users', targetMount: '/mnt/data', recovery: '/private/README.txt' }
  const migration = new CommunityUserStorageMigration({
    prepare: async () => ({ state: 'complete', result }),
    stopCarriers: async () => {
      throw new Error('Unexpected stop')
    },
    copy: async () => {
      throw new Error('Unexpected copy')
    },
    verify: async () => {
      throw new Error('Unexpected verify')
    },
    publish: async () => {
      throw new Error('Unexpected publish')
    },
    rollback: async () => {
      throw new Error('Unexpected rollback')
    },
    close: async () => {
      events.push('unlock')
    },
  })
  expect(await migration.migrate(result.targetRoot, result.targetMount)).toEqual(result)
  expect(events).toEqual(['unlock'])
})

it('rolls back only after stopped-carrier preparation and never recopies either retained tree', async () => {
  const events: string[] = []
  const result = { sourceRoot: '/mnt/new/users', targetRoot: '/old/users', targetMount: null, recovery: '/private/README.txt', direction: 'rollback' as const }
  const migration = new CommunityUserStorageMigration({
    prepare: async (_target, _mount, direction) => {
      expect(direction).toBe('rollback')
      events.push('prepare')
      return { state: 'pending' }
    },
    stopCarriers: async () => {
      events.push('stop')
    },
    copy: async () => {
      throw Error('Rollback must retain both trees')
    },
    verify: async () => {
      throw Error('Rollback must not recopy the source')
    },
    publish: async () => {
      throw Error('Unexpected forward publication')
    },
    rollback: async () => {
      events.push('rollback')
      return result
    },
    close: async () => {
      events.push('close')
    },
  })
  expect(await migration.rollback('/mnt/new/users', '/mnt/new')).toEqual(result)
  expect(events).toEqual(['prepare', 'stop', 'rollback', 'close'])
})
