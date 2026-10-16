import { spawnSync } from 'node:child_process'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'

it('accepts all 67 Linux cases and only the explicitly excluded real-news credential case', async () => {
  const root = await mkdtemp(join(tmpdir(), 'linux-results-'))
  try {
    const regular = { success: true, numFailedTests: 0, numPendingTests: 0, numPassedTests: 66,
      testResults: Array.from({ length: 52 }, (_, file) => ({ name: `case-${file}.e2e.ts`,
        assertionResults: Array.from({ length: file < 14 ? 2 : 1 }, (_, test) => ({ title: `case ${file}/${test}`, status: 'passed' })),
      })),
    }
    const migration = { success: true, numFailedTests: 0, numPendingTests: 1, numPassedTests: 1, testResults: [{ assertionResults: [
      { title: 'preserves Node module resolution for migrated skill scripts and prepares updated skill sources', status: 'passed' },
      { title: 'migrates the real news installation without preparation credentials, falls back on failure and rotates execution credentials without rebuilding', status: 'skipped' },
    ] }] }
    const regularPath = join(root, 'linux.json'), migrationPath = join(root, 'migration.json')
    await writeFile(regularPath, JSON.stringify(regular)); await writeFile(migrationPath, JSON.stringify(migration))
    const invoke = () => spawnSync(process.execPath, [resolve('scripts/validation/verify-linux-results.mjs'), regularPath, migrationPath], { encoding: 'utf8' })
    const result = invoke(); expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('67 selected cases passed')
    for (const invalid of ['skipped', 'failed']) {
      regular.testResults[0]!.assertionResults[0]!.status = invalid
      await writeFile(regularPath, JSON.stringify(regular)); expect(invoke().status).not.toBe(0)
    }
    regular.testResults[0]!.assertionResults[0]!.status = 'passed'
    await writeFile(regularPath, JSON.stringify(regular))
    migration.testResults[0]!.assertionResults[0]!.status = 'skipped'
    await writeFile(migrationPath, JSON.stringify(migration)); expect(invoke().status).not.toBe(0)
    migration.testResults[0]!.assertionResults[0]!.status = 'passed'
    migration.testResults[0]!.assertionResults[1]!.title = 'an unexplained skipped case'
    await writeFile(migrationPath, JSON.stringify(migration)); expect(invoke().status).not.toBe(0)
  } finally { await rm(root, { recursive: true, force: true }) }
})
