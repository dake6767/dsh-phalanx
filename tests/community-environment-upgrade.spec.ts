import { expect, it } from 'vitest'
import { CommunityEnvironmentUpgrade } from '../src/use-cases/community-environment-upgrade.js'

it('backs up legacy configuration before marking an upgrade complete, preserving the backup and model-choice notice on repeat entry', async () => {
  const events: string[] = []; let complete: { selectSharedModel: boolean } | undefined
  const upgrade = new CommunityEnvironmentUpgrade({
    inspect: async () => complete === undefined ? { state: 'legacy' } : { state: 'complete', ...complete },
    complete: async (_user, _space, result) => { events.push('complete'); complete = result },
  }, { backup: async (user, space) => { events.push(`backup:${user}:${space}`); return { id: 'backup-1', location: '/private/backup-1', restoreInstructions: 'Follow README.txt' } } })
  expect(await upgrade.prepare('alice', 'alice-space')).toEqual({ selectSharedModel: true })
  expect(await upgrade.prepare('alice', 'alice-space')).toEqual({ selectSharedModel: true })
  expect(events).toEqual(['backup:alice:alice-space', 'complete'])
})

it('does not admit native migration when backup fails, and retries without treating partial work as complete', async () => {
  let failed = true; let completed = false; let backups = 0
  const upgrade = new CommunityEnvironmentUpgrade({ inspect: async () => ({ state: 'legacy' }), complete: async () => { completed = true } }, {
    backup: async () => { backups++; if (failed) throw new Error('fixture backup failure'); return { id: 'backup', location: '/private/backup', restoreInstructions: 'Follow README.txt' } },
  })
  await expect(upgrade.prepare('alice', 'alice-space')).rejects.toMatchObject({ reason: 'upgrade-unavailable' })
  expect(completed).toBe(false)
  failed = false; expect(await upgrade.prepare('alice', 'alice-space')).toEqual({ selectSharedModel: true })
  expect(backups).toBe(2); expect(completed).toBe(true)
})
it('marks new spaces current without backing up nonexistent settings', async () => {
  let completed = false
  const upgrade = new CommunityEnvironmentUpgrade({ inspect: async () => ({ state: 'new' }), complete: async (_user, _space, result) => { expect(result).toEqual({ selectSharedModel: false }); completed = true } }, {
    backup: async () => { throw new Error('Unexpected backup') },
  })
  expect(await upgrade.prepare('alice', 'alice-space')).toEqual({ selectSharedModel: false }); expect(completed).toBe(true)
})
