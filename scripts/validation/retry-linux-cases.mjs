import { readFileSync, writeFileSync, mkdirSync, openSync, closeSync } from 'node:fs'
import { resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'

const [input, ...extra] = process.argv.slice(2)
if (!input || extra.length) throw Error('Usage: node scripts/validation/retry-linux-cases.mjs REPORT.json')
const path = resolve(input), prefix = path.replace(/\.json$/u, '')
if (prefix === path) throw Error('Expected a JSON report path')
const original = readFileSync(path, 'utf8'), report = JSON.parse(original)
if (!report.numFailedTests || report.numRuntimeErrorTestSuites || report.snapshot?.failure ||
    report.testResults.some(file => file.status === 'failed' && !file.assertionResults.some(row => row.status === 'failed'))) throw Error('Suite errors require diagnosis; no individual case can confirm them')
const receiptPath = prefix + '-retries.json'
const receipt = { firstReport: path, firstReportSha256: createHash('sha256').update(original).digest('hex'),
  sourceCommit: process.env.DSH_PHALANX_CANDIDATE_SHA ?? null, attempts: [] }
// Exclusive creation prevents a repeated command from resetting the retry budget.
writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' })
const save = () => writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + '\n')
for (const file of report.testResults) {
  for (const row of file.assertionResults.filter(row => row.status === 'failed')) {
    // Quota failures need the provider's reset window, not an immediate retry.
    if (/rate.?limit|too many requests|quota|\b429\b/iu.test((row.failureMessages ?? []).join('\n'))) continue
    for (let attempt = 1; attempt <= 2; attempt++) {
      const id = receipt.attempts.length + 1, resultPath = `${prefix}-retry-${id}.json`
      const evidence = `${prefix}-retry-${id}-evidence`
      mkdirSync(evidence, { recursive: true })
      const entry = { file: file.name, fullName: row.fullName, attempt, report: resultPath, status: 'interrupted' }
      receipt.attempts.push(entry); save()
      const log = openSync(`${prefix}-retry-${id}.log`, 'w')
      let result
      try {
        const name = [...row.ancestorTitles, row.title].join(' > ')
        result = spawnSync(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', '--config', 'vitest.e2e.config.ts',
          file.name, '-t', '^' + name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&') + '$',
          '--reporter=default', '--reporter=json', `--outputFile=${resultPath}`],
        { stdio: ['ignore', log, log], env: { ...process.env, DSH_PHALANX_E2E_EVIDENCE_DIR: evidence } })
      } finally { closeSync(log) }
      if (result.error || result.signal) throw result.error ?? Error('Single-case retry interrupted')
      const retried = JSON.parse(readFileSync(resultPath, 'utf8'))
      const cases = retried.testResults.flatMap(file => file.assertionResults)
      const active = cases.filter(row => row.status !== 'skipped' && row.status !== 'pending')
      const passed = result.status === 0 && retried.success && !retried.numRuntimeErrorTestSuites && active.length === 1 &&
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
