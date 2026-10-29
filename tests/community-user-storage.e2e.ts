// Validation: T2; real credentials: none; actual Linux rootless DSH. Missing inputs must fail the T2 report gate.
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import type { CommunityApplication } from '../src/ports/community-application.js'
import { removeCommunityFixture } from './fixtures/owned-cleanup.js'
import { createCommunityApplication } from './support/community-application.js'
import { runtimeSettings } from './support/real-dsh-kit.js'
import { runtimeSection } from './support/real-dsh-runtime.js'

it.each([tmpdir(), '/dev/shm'])('refuses an absent data disk even when its parent %s is mounted', async parent => {
  if (process.platform !== 'linux' || runtimeSettings.containerImage === undefined) throw new Error('Linux container validation is required')
  const root = await mkdtemp(join(tmpdir(), 'storage-platform-'))
  const userDataRoot = await mkdtemp(join(parent, 'storage-unmounted-'))
  let app: CommunityApplication | undefined
  try {
    app = createCommunityApplication({
      listen: { host: '127.0.0.1', port: 0 },
      sessionSecret: 'storage-fixture-secret-at-least-32-bytes',
      runtime: { ...runtimeSection(root, 'http://127.0.0.1:1', runtimeSettings), userDataRoot, userDataMount: userDataRoot },
    })
    await expect(app.start()).rejects.toThrow(/storage/iu)
    expect(await readdir(userDataRoot)).toEqual([])
  } finally {
    await app?.stop()
    await removeCommunityFixture(root)
    await rm(userDataRoot, { recursive: true, force: true })
  }
})
