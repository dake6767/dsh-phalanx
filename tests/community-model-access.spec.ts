import { mkdtemp, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { FileCommunityModelAccess } from '../src/adapters/community-model-access.js'

describe('community runtime model access', () => {
  it('keeps distinct opaque user access stable after a platform restart in protected storage', async () => {
    const root = await mkdtemp(join(tmpdir(), 'community-model-access-'))
    try {
      const path = join(root, 'model-access.json')
      const access = new FileCommunityModelAccess(path)
      const alice = access.forUser('alice'); const bob = access.forUser('bob')
      expect(alice).not.toBe(bob)
      expect(alice).not.toContain('alice')
      expect(access.resolve(alice)).toBe('alice')
      expect(access.resolve('wrong')).toBeUndefined()
      expect((await stat(path)).mode & 0o777).toBe(0o600)
      const restarted = new FileCommunityModelAccess(path)
      expect(restarted.forUser('alice')).toBe(alice)
      expect(restarted.resolve(bob)).toBe('bob')
    } finally { await rm(root, { recursive: true, force: true }) }
  })
})
