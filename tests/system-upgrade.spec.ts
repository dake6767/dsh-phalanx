import { spawnSync } from 'node:child_process'
import { expect, it } from 'vitest'

it('shares fixed release preparation, transaction and verified recovery through the public upgrade seam', () => {
  const result = spawnSync('python3', ['tests/fixtures/upgrade-core.py'], { encoding: 'utf8', timeout: 30000 })
  expect(result.status, result.stderr).toBe(0)
})

it('rejects unauthorized or unbounded privileged requests through the Unix HTTP seam', () => {
  const result = spawnSync('python3', ['tests/fixtures/upgrade-executor.py'], { encoding: 'utf8', timeout: 30000, env: { ...process.env, PYTHONPATH: 'scripts/install' } })
  expect(result.status, result.stderr).toBe(0)
})

it('checks peak disk capacity at actual filesystem boundaries before writes', () => {
  const result = spawnSync('python3', ['tests/fixtures/upgrade-space.py'], { encoding: 'utf8', timeout: 30000 })
  expect(result.status, result.stderr).toBe(0)
})

it('bootstraps only a small verified updater while the old platform keeps serving', () => {
  const result = spawnSync('python3', ['tests/fixtures/upgrade-bootstrap.py'], { encoding: 'utf8', timeout: 30000 })
  expect(result.status, result.stderr).toBe(0)
})

it('derives capacity from actual archived files and expanded OCI layers', () => {
  const result = spawnSync('python3', ['tests/fixtures/release-storage.py'], { encoding: 'utf8', timeout: 30000 })
  expect(result.status, result.stderr).toBe(0)
})
