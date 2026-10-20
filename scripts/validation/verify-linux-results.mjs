import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { selection, validateFiles } from './t2-plan.mjs'

export function verifyRegular(regular, files) {
    validateFiles(files)
  const assertions = regular.testResults.flatMap(file => file.assertionResults)
  const expected = files.reduce((sum, file) => sum + selection.regularFileCases[file], 0)
  const reported = regular.testResults.map(file => 'tests/' + file.name.replaceAll('\\', '/').split('/tests/').at(-1).replace(/^tests\//u, ''))
  if (!regular.success || regular.numFailedTests !== 0 || regular.numPendingTests !== 0 ||
      regular.testResults.length !== files.length || new Set(reported).size !== files.length ||
      reported.some(file => !files.includes(file)) || regular.numPassedTests !== expected || assertions.length !== expected ||
      regular.testResults.some((file, index) => file.assertionResults.length !== selection.regularFileCases[reported[index]]) ||
      assertions.some(row => row.status !== 'passed')) {
    throw new Error('Every selected installed Linux case must run and pass')
  }
  return expected
}

export function verifyMigration(migration) {
  const cases = migration.testResults.flatMap(file => file.assertionResults)
  const selected = 'preserves Node module resolution for migrated skill scripts and prepares updated skill sources'
  const t4 = 'migrates the real news installation without preparation credentials, falls back on failure and rotates execution credentials without rebuilding'
  if (!migration.success || migration.numFailedTests !== 0 || migration.numPassedTests !== 1 || migration.numPendingTests !== 1 ||
      cases.length !== 2 || !cases.some(row => row.title === selected && row.status === 'passed') ||
      !cases.some(row => row.title === t4 && row.status === 'skipped')) {
    throw new Error('Exactly the no-key migration case must pass; only the named real-news credential case belongs to T4')
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [regularPath, migrationPath, ...options] = process.argv.slice(2)
  const subset = options[0] === '--files' && options.length === 2 ? options[1].split(',') : undefined
  if (options.length && !subset) throw new Error('Expected --files with a comma-separated inventory subset')
  const expected = verifyRegular(JSON.parse(readFileSync(regularPath, 'utf8')), subset ?? selection.regular)
  if (!subset) verifyMigration(JSON.parse(readFileSync(migrationPath, 'utf8')))
  console.log(`${expected} selected cases passed${subset ? '.' : '; the named real-news credential case is excluded: T4 only.'}`)
}
