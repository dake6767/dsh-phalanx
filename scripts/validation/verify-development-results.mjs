// Revalidate the complete original selection after combining retained passes and failed-file reruns.
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { mergeReports } from './file-runner.mjs'
import { verifyRegular } from './verify-linux-results.mjs'
const path = process.argv[2],
  summary = JSON.parse(readFileSync(path, 'utf8'))
if (
  summary.files.length !== summary.expectedFiles.length ||
  new Set(summary.files.map(row => row.file)).size !== summary.expectedFiles.length ||
  summary.files.some(row => row.status !== 'passed' || !summary.expectedFiles.includes(row.file))
)
  throw Error('Every original file must have one passing execution')
const regular = summary.files
if (regular.length) {
  const report = mergeReports(regular.map(row => row.report))
  verifyRegular(
    report,
    regular.map(row => row.file),
  )
  writeFileSync(join(dirname(path), 'combined-linux.json'), JSON.stringify(report, null, 2) + '\n')
}
console.log(`Verified ${summary.files.length} original Linux files with retained byte identities`)
