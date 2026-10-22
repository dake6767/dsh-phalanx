import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { FilePluginArchiveSource } from '../src/adapters/plugin-archive-source.js'

it('streams only retained original archives inside the artifact root and refuses traversal or links outside it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'plugin-archive-source-')), hash = '1'.repeat(128), directory = join(root, 'plugins/artifacts', hash)
  try {
    await mkdir(directory, { recursive: true }); await writeFile(join(directory, 'original.tgz'), 'checked')
    const source = new FilePluginArchiveSource(root), archive = await source.open('artifacts/' + hash), chunks: Uint8Array[] = []
    for await (const chunk of archive.body) chunks.push(chunk)
    expect(archive.size).toBe(7); expect(Buffer.concat(chunks).toString()).toBe('checked')
    await expect(source.open('../outside')).rejects.toThrow()
    await writeFile(join(root, 'outside.tgz'), 'private')
    await rm(join(directory, 'original.tgz')); await symlink(join(root, 'outside.tgz'), join(directory, 'original.tgz'))
    await expect(source.open('artifacts/' + hash)).rejects.toThrow()
    await rm(directory, { recursive: true }); await symlink(root, directory)
    await expect(source.open('artifacts/' + hash)).rejects.toThrow()
    expect(await readFile(join(root, 'outside.tgz'), 'utf8')).toBe('private')
  } finally { await rm(root, { recursive: true, force: true }) }
})
