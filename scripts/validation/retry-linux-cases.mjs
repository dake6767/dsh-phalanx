import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { resolve, relative } from 'node:path'
import { createHash } from 'node:crypto'
import { runFile } from './file-runner.mjs'
const selection = JSON.parse(readFileSync(new URL('./t2-selection.json', import.meta.url), 'utf8'))
const browserFiles = JSON.parse(readFileSync(new URL('./local-browser-files.json', import.meta.url), 'utf8'))
// Browser confirmations have their own ranges after Linux; ad hoc reports use the next unused index.
const inventory = [...new Set([...selection.regular, ...selection.smoke, selection.migration.file, ...browserFiles])]

const [input, ...extra] = process.argv.slice(2)
if (!input || (extra.length && (extra.length !== 1 || !['--without-containers', '--unit'].includes(extra[0])))) throw Error('Usage: node scripts/validation/retry-linux-cases.mjs REPORT.json [--without-containers|--unit]')
const path = resolve(input), prefix = path.replace(/\.json$/u, '')
if (prefix === path) throw Error('Expected a JSON report path')
const original = readFileSync(path, 'utf8'), report = JSON.parse(original)
const unit = extra.includes('--unit')
if (unit && report.testResults.some(file => !file.name.endsWith('.spec.ts'))) throw Error('Quick confirmation requires unit test files')
if (!report.numFailedTests || report.numRuntimeErrorTestSuites || report.snapshot?.failure ||
    report.testResults.some(file => file.status === 'failed' && !file.assertionResults.some(row => row.status === 'failed'))) throw Error('Suite errors require diagnosis; no individual case can confirm them')
const receiptPath = prefix + '-retries.json'
const receipt = { firstReport: path, firstReportSha256: createHash('sha256').update(original).digest('hex'),
  sourceCommit: process.env.DSH_PHALANX_VALIDATION_SOURCE_SHA ?? process.env.DSH_PHALANX_CANDIDATE_SHA ?? null, attempts: [] }
// Exclusive creation prevents a repeated command from resetting the retry budget.
writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' })
const save = () => writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + '\n')
for (const file of report.testResults) {
  const index = inventory.indexOf(relative(process.cwd(), file.name))
  for (const row of file.assertionResults.filter(row => row.status === 'failed')) {
    // Quota failures need the provider's reset window, not an immediate retry.
    if (/rate.?limit|too many requests|quota|\b429\b/iu.test((row.failureMessages ?? []).join('\n'))) continue
    for (let attempt = 1; attempt <= 2; attempt++) {
      const id = receipt.attempts.length + 1, resultPath = `${prefix}-retry-${id}.json`
      const evidence = `${prefix}-retry-${id}-evidence`
      mkdirSync(evidence, { recursive: true })
      const entry = { file: file.name, fullName: row.fullName, attempt, report: resultPath, status: 'interrupted' }
      receipt.attempts.push(entry); save()
      const name = [...row.ancestorTitles, row.title].join(' > ')
      const filter = '^' + name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&') + '$'
      const execution = await runFile({ file: file.name, containerChecks: !unit && !extra.includes('--without-containers'),
        index: index < 0 ? inventory.length : index, directory: evidence,
        extra: ['-t', filter],
        ...(unit ? { command: [process.execPath, 'node_modules/vitest/vitest.mjs', 'run', '--config', 'vitest.config.ts', file.name,
          '--maxWorkers=1', '-t', filter, '--reporter=default', '--reporter=json', '--outputFile=' + resolve(evidence, 'report.json')] } : {}) })
      if (execution.status === 'environment-failed' || execution.signal || execution.error) {
        entry.status = 'failed'; save(); throw Error('Single-case retry environment failed; inspect ' + evidence)
      }
      writeFileSync(resultPath, readFileSync(execution.report))
      const retried = JSON.parse(readFileSync(resultPath, 'utf8'))
      const cases = retried.testResults.flatMap(file => file.assertionResults)
      const active = cases.filter(row => row.status !== 'skipped' && row.status !== 'pending')
      const passed = execution.status === 'passed' && retried.success && !retried.numRuntimeErrorTestSuites && active.length === 1 &&
        active[0].fullName === row.fullName && active[0].status === 'passed'
      entry.status = passed ? 'passed' : 'failed'; save()
      if (passed) { Object.assign(row, active[0]); break }
      if (/rate.?limit|too many requests|quota|\b429\b/iu.test(cases.flatMap(row => row.failureMessages ?? []).join('\n'))) break
    }
  }
  file.status = file.assertionResults.every(row => ['passed', 'skipped', 'pending', 'todo'].includes(row.status)) ? 'passed' : 'failed'
}
const cases = report.testResults.flatMap(file => file.assertionResults)
report.numPassedTests = cases.filter(row => row.status === 'passed').length
report.numFailedTests = cases.filter(row => row.status === 'failed').length
report.numPassedTestSuites = report.testResults.filter(file => file.status === 'passed').length
report.numFailedTestSuites = report.testResults.filter(file => file.status === 'failed').length
report.success = report.numFailedTests === 0 && report.numFailedTestSuites === 0
writeFileSync(prefix + '-confirmed.json', JSON.stringify(report, null, 2) + '\n')
console.log(`Single-case confirmation: ${report.numPassedTests} passed, ${report.numFailedTests} still failed; original report ${path}`)
process.exitCode = report.success ? 0 : 1
