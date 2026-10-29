import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { inspectDataRoot } from '../src/adapters/data-root-layout.js'

it('accepts populated rebuildable subtrees and refuses durable facts, unknown siblings and redirected roots', async () => {
  const root = await mkdtemp(join(tmpdir(), 'data-root-layout-'))
  try {
    await mkdir(join(root, 'skills/artifacts/fixture'), { recursive: true })
    await writeFile(join(root, 'skills/artifacts/fixture/manifest.json'), '{}')
    await mkdir(join(root, 'plugins/uploads/incoming'), { recursive: true })
    await mkdir(join(root, 'mcp/members/member'), { recursive: true })
    await writeFile(join(root, 'platform.lock'), '')
    expect(await inspectDataRoot(root)).toEqual({
      artifacts: ['plugins/uploads/incoming', 'skills/artifacts'],
      projections: ['mcp/members'],
      runtime: [],
      files: ['platform.lock'],
    })
    for (const path of ['postgres', 'users', 'environment-upgrades', 'skills/facts.json', 'platform-lock.db']) {
      await writeFile(join(root, path), 'unapproved')
      await expect(inspectDataRoot(root)).rejects.toThrow(path)
      await rm(join(root, path))
    }
    await mkdir(join(root, 'unknown'))
    await expect(inspectDataRoot(root)).rejects.toThrow('unknown')
    await rm(join(root, 'unknown'), { recursive: true })
    await symlink(join(root, 'skills/artifacts'), join(root, 'skills/members'))
    await expect(inspectDataRoot(root)).rejects.toThrow('skills/members')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
