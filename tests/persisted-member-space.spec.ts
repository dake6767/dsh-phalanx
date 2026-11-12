import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { effectiveUserDataRoot } from '../src/domain/storage-layout.js'
import { openTestAccounts, openTestDatabase, testDatabaseConfigFile } from './support/community-application.js'
import { persistedMemberSpacePath } from './support/persisted-member-space.js'

it('reads new and retained mappings only from the explicitly selected persistent database', async () => {
  const root = await mkdtemp(join(tmpdir(), 'persisted-member-space-'))
  try {
    const accounts = await openTestAccounts(root)
    const member = await accounts.createFirstAdmin({ username: 'member', email: '', password: 'password' })
    await accounts.close()
    const config = testDatabaseConfigFile(root)
    expect(await persistedMemberSpacePath(root, config, 'member')).toBe(join(effectiveUserDataRoot({ dataRoot: root }), '_spaces', member.spaceId))
    const database = await openTestDatabase(root)
    await database.query("UPDATE dsh_phalanx.accounts SET storage_key='legacy' WHERE username='member'")
    await database.close()
    expect(await persistedMemberSpacePath(root, config, 'member')).toBe(join(effectiveUserDataRoot({ dataRoot: root }), 'legacy'))
    await expect(persistedMemberSpacePath(root, config, 'missing')).rejects.toThrow('no persisted space')
    await expect(persistedMemberSpacePath(root, join(root, 'missing.json'), 'member')).rejects.toThrow()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
