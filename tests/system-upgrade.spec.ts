import { spawnSync } from 'node:child_process'
import { expect, it } from 'vitest'
import { pythonFixtureCases } from './python-fixture-cases.js'

it('exposes stable update codes and timing through the public transaction projection', () => {
  const result = spawnSync('python3', ['tests/fixtures/upgrade-codes.py'], {
    encoding: 'utf8',
    timeout: 30000,
    env: { ...process.env, PYTHONPATH: 'scripts/install' },
  })
  expect(result.status, result.stderr).toBe(0)
})

it('reads fresh image identities over Unix HTTP without dropping live process checks', () => {
  const result = spawnSync('python3', ['tests/fixtures/upgrade-image-inspection.py'], {
    encoding: 'utf8',
    timeout: 30000,
    env: { ...process.env, PYTHONPATH: 'scripts/install' },
  })
  expect(result.status, result.stderr).toBe(0)
})

it('serves installed bilingual maintenance pages and closes their socket before platform handoff', () => {
  const result = spawnSync('python3', ['tests/fixtures/upgrade-maintenance.py'], {
    encoding: 'utf8',
    timeout: 30000,
    env: { ...process.env, PYTHONPATH: 'scripts/install' },
  })
  expect(result.status, result.stderr).toBe(0)
})

it.each(pythonFixtureCases('upgrade-channels'))('public upgrade channel seam: %s', testCase => {
  const started = performance.now()
  const result = spawnSync('python3', ['tests/fixtures/upgrade-channels.py', testCase], {
    encoding: 'utf8',
    timeout: 30000,
    env: { ...process.env, PYTHONPATH: 'scripts/install' },
  })
  console.info(
    'Upgrade channel fixture completed:',
    JSON.stringify({
      testCase,
      elapsedMs: Math.round(performance.now() - started),
      status: result.status,
      signal: result.signal,
      error: result.error?.message,
      stderr: result.stderr?.slice(-1000),
    }),
  )
  expect(result.status, result.stderr).toBe(0)
})

it.each(pythonFixtureCases('upgrade-core'))('public upgrade seam: %s', testCase => {
  const result = spawnSync('python3', ['tests/fixtures/upgrade-core.py', testCase], { encoding: 'utf8', timeout: 30000 })
  expect(result.status, JSON.stringify({ stderr: result.stderr, signal: result.signal, error: result.error?.message })).toBe(0)
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

it.each(pythonFixtureCases('upgrade-cleanup'))(
  'public upgrade cleanup: %s',
  testCase => {
    const result = spawnSync('python3', ['tests/fixtures/upgrade-cleanup.py', testCase], { encoding: 'utf8', timeout: 30000 })
    expect(result.status, JSON.stringify({ stderr: result.stderr, signal: result.signal, error: result.error?.message })).toBe(0)
  },
  30_000,
)

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
}, 30_000)

it('recovers managed platform operations through protected journals and exact admission ownership', () => {
  const result = spawnSync('python3', ['tests/fixtures/platform-operations.py'], {
    encoding: 'utf8',
    timeout: 30000,
    env: { ...process.env, PYTHONPATH: 'scripts/install' },
  })
  expect(result.status, result.stderr).toBe(0)
})

it('shares schema ranges, upgrade routes and tolerant reader conclusions with release tooling', () => {
  const result = spawnSync('python3', ['tests/fixtures/compatibility-protocol.py'], {
    encoding: 'utf8',
    timeout: 30000,
    env: { ...process.env, PYTHONPATH: 'scripts/install' },
  })
  expect(result.status, result.stderr).toBe(0)
})
