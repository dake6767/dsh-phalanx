import { readFileSync } from 'node:fs'

const [regularPath, migrationPath] = process.argv.slice(2)
const regular = JSON.parse(readFileSync(regularPath, 'utf8'))
const assertions = regular.testResults.flatMap(file => file.assertionResults)
if (!regular.success || regular.numFailedTests !== 0 || regular.numPendingTests !== 0 ||
    regular.testResults.length !== 52 || regular.numPassedTests !== 66 || assertions.length !== 66 ||
    assertions.some(row => row.status !== 'passed')) {
  throw new Error('Every selected installed Linux case must run and pass')
}
const migration = JSON.parse(readFileSync(migrationPath, 'utf8'))
const cases = migration.testResults.flatMap(file => file.assertionResults)
const selected = 'preserves Node module resolution for migrated skill scripts and prepares updated skill sources'
const t4 = 'migrates the real news installation without preparation credentials, falls back on failure and rotates execution credentials without rebuilding'
if (!migration.success || migration.numFailedTests !== 0 || migration.numPassedTests !== 1 || migration.numPendingTests !== 1 ||
    cases.length !== 2 || !cases.some(row => row.title === selected && row.status === 'passed') ||
    !cases.some(row => row.title === t4 && row.status === 'skipped')) {
  throw new Error('Exactly the no-key migration case must pass; only the named real-news credential case belongs to T4')
}
console.log('67 selected cases passed; the named real-news credential case is excluded: T4 only.')
