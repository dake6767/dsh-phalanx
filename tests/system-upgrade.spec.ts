import { spawnSync } from 'node:child_process'
import { expect, it } from 'vitest'

it('shares fixed release preparation, transaction and verified recovery through the public upgrade seam', () => {
  const result = spawnSync('python3', ['tests/fixtures/upgrade-core.py'], { encoding: 'utf8', timeout: 30000 })
  expect(result.status, result.stderr).toBe(0)
})

it('rejects unauthorized or unbounded privileged requests through the Unix HTTP seam', () => {
  const result = spawnSync('python3', ['tests/fixtures/upgrade-executor.py'], {
    encoding: 'utf8',
    timeout: 30000,
    env: { ...process.env, PYTHONPATH: 'scripts/install' },
  })
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

it('cleans only proven unused releases and retries independently of committed updates', () => {
  const result = spawnSync('python3', ['tests/fixtures/upgrade-cleanup.py'], { encoding: 'utf8', timeout: 30000 })
  expect(result.status, result.stderr).toBe(0)
}, 30_000)

it('asks the installed platform for facts only when it and its database exist', () => {
  const result = spawnSync('python3', ['tests/fixtures/installer-platform-facts.py'], {
    encoding: 'utf8',
    timeout: 30000,
    env: { ...process.env, PYTHONPATH: 'scripts/install' },
  })
  expect(result.status, result.stderr).toBe(0)
})

it('shares one flock between the running platform and the upgrader quiescence', () => {
  const result = spawnSync('python3', ['tests/fixtures/upgrade-platform-lock.py'], {
    encoding: 'utf8',
    timeout: 60000,
    env: { ...process.env, PYTHONPATH: 'scripts/install' },
  })
  expect(result.status, result.stderr).toBe(0)
})

it('enforces the shipped fresh-install release policy', () => {
  const result = spawnSync('python3', ['tests/fixtures/release-policy.py'], {
    encoding: 'utf8',
    timeout: 30000,
    env: { ...process.env, PYTHONPATH: 'scripts/install' },
  })
  expect(result.status, result.stderr).toBe(0)
})

it('refuses legacy deployments before database I/O through CLI and Unix HTTP', () => {
  const result = spawnSync('python3', ['tests/fixtures/upgrade-database.py'], {
    encoding: 'utf8',
    timeout: 30000,
    env: { ...process.env, PYTHONPATH: 'scripts/install' },
  })
  expect(result.status, result.stderr).toBe(0)
})

it('recovers managed platform operations through protected journals and exact admission ownership', () => {
  const result = spawnSync('python3', ['tests/fixtures/platform-operations.py'], {
    encoding: 'utf8',
    timeout: 30000,
    env: { ...process.env, PYTHONPATH: 'scripts/install' },
  })
  expect(result.status, result.stderr).toBe(0)
})
