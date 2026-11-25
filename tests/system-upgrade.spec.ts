import { expect, it } from 'vitest'
import { pythonFixtureCases } from './python-fixture-cases.js'
import { runAsyncCommand } from './support/async-command.js'

const runPython = (args: readonly string[], options: { readonly timeout?: number; readonly pythonPath?: boolean } = {}) =>
  runAsyncCommand('python3', args, {
    timeout: options.timeout ?? 28_000,
    ...(options.pythonPath ? { env: { ...process.env, PYTHONPATH: 'scripts/install' } } : {}),
  })

it.concurrent(
  'exposes stable update codes and timing through the public transaction projection',
  async () => {
    const result = await runPython(['tests/fixtures/upgrade-codes.py'], { pythonPath: true })
    expect(result.status, result.stderr).toBe(0)
  },
  35_000,
)

it.concurrent(
  'reads fresh image identities over Unix HTTP without dropping live process checks',
  async () => {
    const result = await runPython(['tests/fixtures/upgrade-image-inspection.py'], { pythonPath: true })
    expect(result.status, result.stderr).toBe(0)
  },
  35_000,
)

it.concurrent(
  'serves installed bilingual maintenance pages and closes their socket before platform handoff',
  async () => {
    const result = await runPython(['tests/fixtures/upgrade-maintenance.py'], { pythonPath: true })
    expect(result.status, result.stderr).toBe(0)
  },
  35_000,
)

it.concurrent.each(pythonFixtureCases('upgrade-channels'))(
  'public upgrade channel seam: %s',
  async testCase => {
    const started = performance.now()
    const result = await runPython(['tests/fixtures/upgrade-channels.py', testCase], { pythonPath: true })
    console.info(
      'Upgrade channel fixture completed:',
      JSON.stringify({
        testCase,
        elapsedMs: Math.round(performance.now() - started),
        status: result.status,
        signal: result.signal,
        error: result.error,
        stderr: result.stderr.slice(-1000),
      }),
    )
    expect(result.status, result.stderr).toBe(0)
  },
  35_000,
)

it.concurrent.each(pythonFixtureCases('upgrade-core'))(
  'public upgrade seam: %s',
  async testCase => {
    const result = await runPython(['tests/fixtures/upgrade-core.py', testCase])
    expect(result.status, JSON.stringify({ stderr: result.stderr, signal: result.signal, error: result.error })).toBe(0)
  },
  35_000,
)

it.concurrent(
  'rejects unauthorized or unbounded privileged requests through the Unix HTTP seam',
  async () => {
    const result = await runPython(['tests/fixtures/upgrade-executor.py'], { pythonPath: true })
    expect(result.status, result.stderr).toBe(0)
  },
  35_000,
)

it.concurrent(
  'checks peak disk capacity at actual filesystem boundaries before writes',
  async () => {
    const result = await runPython(['tests/fixtures/upgrade-space.py'])
    expect(result.status, result.stderr).toBe(0)
  },
  35_000,
)

it.concurrent(
  'bootstraps only a small verified updater while the old platform keeps serving',
  async () => {
    const result = await runPython(['tests/fixtures/upgrade-bootstrap.py'])
    expect(result.status, result.stderr).toBe(0)
  },
  35_000,
)

it.concurrent(
  'derives capacity from actual archived files and expanded OCI layers',
  async () => {
    const result = await runPython(['tests/fixtures/release-storage.py'])
    expect(result.status, result.stderr).toBe(0)
  },
  35_000,
)

it.concurrent.each(pythonFixtureCases('upgrade-cleanup'))(
  'public upgrade cleanup: %s',
  async testCase => {
    const result = await runPython(['tests/fixtures/upgrade-cleanup.py', testCase])
    expect(result.status, JSON.stringify({ stderr: result.stderr, signal: result.signal, error: result.error })).toBe(0)
  },
  35_000,
)

it.concurrent(
  'asks the installed platform for facts only when it and its database exist',
  async () => {
    const result = await runPython(['tests/fixtures/installer-platform-facts.py'], { pythonPath: true })
    expect(result.status, result.stderr).toBe(0)
  },
  35_000,
)

it.concurrent(
  'shares one flock between the running platform and the upgrader quiescence',
  async () => {
    const result = await runPython(['tests/fixtures/upgrade-platform-lock.py'], { timeout: 58_000, pythonPath: true })
    expect(result.status, result.stderr).toBe(0)
  },
  65_000,
)

it.concurrent(
  'enforces the shipped fresh-install release policy',
  async () => {
    const result = await runPython(['tests/fixtures/release-policy.py'], { pythonPath: true })
    expect(result.status, result.stderr).toBe(0)
  },
  35_000,
)

it.concurrent(
  'refuses legacy deployments before database I/O through CLI and Unix HTTP',
  async () => {
    const result = await runPython(['tests/fixtures/upgrade-database.py'], { pythonPath: true })
    expect(result.status, result.stderr).toBe(0)
  },
  35_000,
)

it.concurrent(
  'recovers managed platform operations through protected journals and exact admission ownership',
  async () => {
    const result = await runPython(['tests/fixtures/platform-operations.py'], { pythonPath: true })
    expect(result.status, result.stderr).toBe(0)
  },
  35_000,
)

it.concurrent(
  'shares schema ranges, upgrade routes and tolerant reader conclusions with release tooling',
  async () => {
    const result = await runPython(['tests/fixtures/compatibility-protocol.py'], { pythonPath: true })
    expect(result.status, result.stderr).toBe(0)
  },
  35_000,
)
