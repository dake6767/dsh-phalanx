import { spawnSync } from 'node:child_process'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'
import selection from '../scripts/validation/t2-selection.json' with { type: 'json' }

it('accepts all required Linux cases and only the explicitly excluded real-news credential case', async () => {
  const root = await mkdtemp(join(tmpdir(), 'linux-results-'))
  try {
    const regular = { success: true, numFailedTests: 0, numPendingTests: 0, numPassedTests: selection.regularCases,
      testResults: selection.regular.map((file, index) => ({ name: resolve(file),
        assertionResults: Array.from({ length: selection.regularFileCases[file as keyof typeof selection.regularFileCases] }, (_, test) => ({ title: `case ${index}/${test}`, status: 'passed' })),
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
    expect(result.stdout).toContain(`${selection.regularCases} selected cases passed`)
    const subset = { ...regular, numPassedTests: 1, testResults: regular.testResults.filter(file => file.name.endsWith('/community-experts.e2e.ts')) }
    await writeFile(regularPath, JSON.stringify(subset))
    const invokeSubset = () => spawnSync(process.execPath, [resolve('scripts/validation/verify-linux-results.mjs'), regularPath, '-', '--files', 'tests/community-experts.e2e.ts'], { encoding: 'utf8' })
    const selected = invokeSubset()
    expect(selected.status, selected.stderr).toBe(0)
    subset.testResults[0]!.assertionResults = []
    await writeFile(regularPath, JSON.stringify(subset)); expect(invokeSubset().status).not.toBe(0)
    await writeFile(regularPath, JSON.stringify(regular))
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
