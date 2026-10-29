import { spawnSync } from 'node:child_process'
import { expect, it } from 'vitest'

it('upgrades and restores shared-image candidates without image transfers or extra image space', () => {
  const result = spawnSync('python3', ['tests/fixtures/installer-image-reuse.py'], {
    encoding: 'utf8',
    timeout: 30000,
    env: { ...process.env, DSH_PHALANX_REUSE_TEST_IMAGE: '', DSH_PHALANX_REUSE_SOURCE: '', DSH_PHALANX_REUSE_TARGET: '' },
  })
  expect(result.status, result.stderr).toBe(0)
}, 30000)

it('limits same-version rehearsal upgrades to explicit marked candidates sharing image and account identity', () => {
  const result = spawnSync('python3', ['tests/fixtures/installer-reuse-rehearsal.py'], { encoding: 'utf8', timeout: 30000 })
  expect(result.status, result.stderr).toBe(0)
}, 30000)
