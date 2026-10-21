import { chmodSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { UserStorageGuard } from '../src/adapters/user-storage-guard.js'

it('rejects lost storage, changed markers and ownership even while mount information can be reused', () => {
  const platform = mkdtempSync(join(tmpdir(), 'storage-platform-')), storage = mkdtempSync(join(tmpdir(), 'storage-volume-'))
  const detached = storage + '-detached'
  try {
    const guard = new UserStorageGuard(platform, storage)
    guard.assertAvailable(); guard.assertAvailable()
    chmodSync(storage, 0o500)
    expect(() => guard.assertAvailable()).toThrow('User data storage is unavailable')
    chmodSync(storage, 0o700); guard.assertAvailable()
    const marker = join(storage, '.dsh-phalanx-storage.json'), original = readFileSync(marker, 'utf8')
    writeFileSync(marker, JSON.stringify({ id: '1'.repeat(32), owner: 'different-platform' }))
    expect(() => guard.assertAvailable()).toThrow('User data storage is unavailable')
    writeFileSync(marker, original); guard.assertAvailable()
    renameSync(storage, detached)
    expect(() => guard.assertAvailable()).toThrow('User data storage is unavailable')
  } finally { rmSync(platform, { recursive: true, force: true }); rmSync(storage, { recursive: true, force: true }); rmSync(detached, { recursive: true, force: true }) }
})
