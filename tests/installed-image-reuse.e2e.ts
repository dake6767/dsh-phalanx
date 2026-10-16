// Validation: T2; real credentials: none; actual rootless installed image.
// Account/systemd and capacity use the installer OS seam; T4 owns real host activation.
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'

it('reuses the actual installed image across fixture candidates with zero image space and verified rollback', async () => {
  if (process.platform !== 'linux' || process.getuid?.() === 0 || !process.env.DSH_PHALANX_INSTALL_ROOT || !process.env.DSH_PHALANX_CONTAINER_IMAGE) {
    throw Error('Requires a verified Linux installation and its rootless candidate image')
  }
  const result = await promisify(execFile)('python3', ['tests/fixtures/installer-image-reuse.py'], {
    timeout: 120_000, env: { ...process.env, DSH_PHALANX_REUSE_TEST_IMAGE: process.env.DSH_PHALANX_CONTAINER_IMAGE },
  })
  expect(result.stderr).toContain('OK')
}, 150_000)
