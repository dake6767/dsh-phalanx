import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { expect, it } from 'vitest'
import { FileCommunityUserSpaces } from '../src/adapters/community-user-spaces.js'

it('keeps independent default user spaces after their rebuildable platform roots are removed', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'durable-user-spaces-'))
  try {
    const roots = [join(directory, 'first'), join(directory, 'second')]
    const homes: string[] = []
    for (const [index, dataRoot] of roots.entries()) {
      const spaces = new FileCommunityUserSpaces(
        { dataRoot },
        { getSpace: async () => ({ spaceId: String(index + 1).repeat(32), storageKey: 'member' }) },
        { assertAvailable: async () => {} },
      )
      const { home } = await spaces.prepare('member')
      homes.push(home)
      expect(relative(dataRoot, home).startsWith('..')).toBe(true)
      await writeFile(join(home, 'retained.txt'), `platform-${index}`)
    }
    expect(homes[0]).not.toBe(homes[1])
    for (const dataRoot of roots) await rm(dataRoot, { recursive: true, force: true })
    expect(await readFile(join(homes[0]!, 'retained.txt'), 'utf8')).toBe('platform-0')
    expect(await readFile(join(homes[1]!, 'retained.txt'), 'utf8')).toBe('platform-1')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
