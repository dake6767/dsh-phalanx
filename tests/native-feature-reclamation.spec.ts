import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { prepareMemberNativeFeatures } from '../src/adapters/member-native-features.js'

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, readdir: vi.fn(actual.readdir), rm: vi.fn(actual.rm) }
})
const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
afterEach(() => {
  vi.mocked(readdir).mockReset().mockImplementation(actual.readdir)
  vi.mocked(rm).mockReset().mockImplementation(actual.rm)
})

it('retains every prior generation when maintenance closes during directory enumeration', async () => {
  const root = await mkdtemp(join(tmpdir(), 'native-feature-reclaim-'))
  let admitted = true
  try {
    const previous = await prepareMemberNativeFeatures(root, false, 'member', [], () => false)
    const retained = await prepareMemberNativeFeatures(root, false, 'member', [], () => false)
    vi.mocked(readdir).mockImplementationOnce(async (...args) => {
      const names = await actual.readdir(...args)
      admitted = false
      return names
    })
    const current = await prepareMemberNativeFeatures(root, false, 'member', [], () => admitted)
    for (const projection of [previous, retained, current]) await expect(readFile(projection.patch)).resolves.toBeInstanceOf(Buffer)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('stops reclaiming further generations when maintenance closes after the first removal', async () => {
  const root = await mkdtemp(join(tmpdir(), 'native-feature-reclaim-'))
  let admitted = true
  try {
    const previous = await prepareMemberNativeFeatures(root, false, 'member', [], () => false)
    const retained = await prepareMemberNativeFeatures(root, false, 'member', [], () => false)
    vi.mocked(rm).mockImplementationOnce(async (...args) => {
      await actual.rm(...args)
      admitted = false
    })
    const current = await prepareMemberNativeFeatures(root, false, 'member', [], () => admitted)
    const old = await Promise.allSettled([readFile(previous.patch), readFile(retained.patch)])
    expect(old.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(old.find(result => result.status === 'rejected')).toMatchObject({ reason: { code: 'ENOENT' } })
    await expect(readFile(current.patch)).resolves.toBeInstanceOf(Buffer)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
