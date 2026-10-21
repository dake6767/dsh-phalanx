import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { FileExpertStore } from '../src/adapters/expert-store.js'

it('invalidates authorization snapshots for every committed expert holding change', async () => {
  const root = await mkdtemp(join(tmpdir(), 'expert-authorization-version-'))
  try {
    const store = new FileExpertStore(join(root, 'experts.json'))
    const initial = store.version()
    store.write({ revision: 0, experts: [], grants: { team: [] }, selections: {} })
    const granted = store.version(); expect(granted).not.toBe(initial)
    store.write({ revision: 0, experts: [], grants: {}, selections: {} })
    expect(store.version()).not.toBe(granted)
  } finally { await rm(root, { recursive: true, force: true }) }
})
