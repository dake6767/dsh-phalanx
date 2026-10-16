import { spawnSync } from 'node:child_process'
import { expect, it } from 'vitest'

it('upgrades and restores shared-image candidates without image transfers or extra image space', () => {
  const result = spawnSync('python3', ['tests/fixtures/installer-image-reuse.py'], { encoding: 'utf8', timeout: 30000,
    env: { ...process.env, DSH_PHALANX_REUSE_TEST_IMAGE: '' } })
  expect(result.status, result.stderr).toBe(0)
}, 30000)
