// The complete local layer: original fast-check budget, docs and controlled browser files.
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { trackedEvidenceInputs } from '../fast-check-inputs.mjs'
import { evidenceInputDigest, fastCheckConfigurationDigest, resolveBrowserMaxWorkers, verifyBrowserReportCompleteness } from '../fast-check-policy.mjs'

if (process.argv.length !== 2) throw Error('Usage: node scripts/validation/local-check.mjs')
const git = args => {
  const result = spawnSync('git', args, { encoding: 'utf8' })
  if (result.status !== 0) throw Error('Cannot determine local check source identity')
  return result.stdout.trim()
}
const readJsonIfExists = path => {
  if (!path || !existsSync(path)) return undefined
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
}
const writeJsonAtomic = (path, value) => {
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`
  writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 })
  renameSync(temporary, path)
}
const files = JSON.parse(readFileSync(new URL('./local-browser-files.json', import.meta.url), 'utf8'))
const root = process.cwd(),
  commit = git(['rev-parse', 'HEAD'])
const clean = git(['status', '--porcelain']) === ''
const browserMaxWorkers = resolveBrowserMaxWorkers(process.env.DSH_PHALANX_VALIDATION_BROWSER_MAX_WORKERS)
const configDigest = fastCheckConfigurationDigest({
  nodeVersion: process.version,
  platform: process.platform,
  arch: process.arch,
  maxWorkers: browserMaxWorkers,
})
const currentTracked = () => ({ ...trackedEvidenceInputs(root), configDigest, imageId: 'controlled-browser-no-image' })
const inputDigest = () => evidenceInputDigest(currentTracked(), files)
const tracked = clean ? currentTracked() : undefined
const digest = tracked ? evidenceInputDigest(tracked, files) : undefined
const fileDigests = tracked ? new Map(files.map(file => [file, evidenceInputDigest(tracked, [file])])) : undefined

const state = process.env.DSH_PHALANX_VALIDATION_STATE_ROOT ?? join(homedir(), '.local/state/dsh-phalanx-validation')
const directory = join(state, 'local-check')
const browserFileCacheDir = join(directory, 'browser-files')
mkdirSync(browserFileCacheDir, { recursive: true, mode: 0o700 })
const started = Date.now(),
  runDirectory = join(directory, 'runs', `${started}-${process.pid}`)
mkdirSync(runDirectory, { recursive: true, mode: 0o700 })
const cached = digest ? join(directory, 'browser-' + digest + '.json') : undefined
const record = {
  protocol: 'local-check-v1',
  commit,
  clean,
  browserMaxWorkers,
  status: 'running',
  startedAt: new Date(started).toISOString(),
  stages: [],
  directory: runDirectory,
}
const stages = [
  ['fast-check', [process.execPath, 'scripts/fast-check.mjs']],
  ['documentation', ['corepack', 'pnpm', 'docs:check']],
  ['browser', []],
]
let browserReusedWhole = false
let browserPendingFiles = []
let browserReusedCommits = []
let browserConfirmations = []
let browserStageConfirmation
for (const [name, command] of stages) {
  if (name === 'browser') {
    const prior = readJsonIfExists(cached)
    if (prior?.status === 'passed' && prior.inputDigest === digest && prior.clean === true && typeof prior.commit === 'string' && prior.commit !== '') {
      browserReusedWhole = true
      record.stages.push({
        name,
        status: 'passed',
        durationMs: 0,
        reusedFrom: prior.commit,
        reusedFiles: files.length,
        executedFiles: 0,
        ...(prior.confirmation ? { confirmation: prior.confirmation } : {}),
      })
      continue
    }
    const reusedFiles = []
    const pendingFiles = []
    for (const file of files) {
      const fileDigest = fileDigests?.get(file)
      const filePrior = fileDigest ? readJsonIfExists(join(browserFileCacheDir, `${fileDigest}.json`)) : undefined
      if (
        filePrior?.status === 'passed' &&
        filePrior.clean === true &&
        filePrior.file === file &&
        filePrior.inputDigest === fileDigest &&
        typeof filePrior.commit === 'string' &&
        filePrior.commit !== ''
      ) {
        reusedFiles.push(file)
        browserReusedCommits.push(filePrior.commit)
        if (filePrior.confirmation) browserConfirmations.push(filePrior.confirmation)
      } else {
        pendingFiles.push(file)
      }
    }
    browserPendingFiles = pendingFiles
    if (pendingFiles.length === 0) {
      const uniqueCommits = [...new Set(browserReusedCommits)]
      const reusedFrom = uniqueCommits.length === 1 ? uniqueCommits[0] : 'per-file-cache'
      const aggregatedConfirmation =
        browserConfirmations.length === 1 ? browserConfirmations[0] : browserConfirmations.length > 1 ? browserConfirmations : undefined
      browserStageConfirmation = aggregatedConfirmation
      record.stages.push({
        name,
        status: 'passed',
        durationMs: 0,
        reusedFrom,
        reusedFiles: reusedFiles.length,
        executedFiles: 0,
        ...(aggregatedConfirmation ? { confirmation: aggregatedConfirmation } : {}),
      })
      continue
    }
    const reportPath = join(runDirectory, 'browser.json')
    const parallelArgs = Number(browserMaxWorkers) > 1 ? ['--fileParallelism', `--maxWorkers=${browserMaxWorkers}`] : ['--maxWorkers=1']
    const browserCommand = [
      'corepack',
      'pnpm',
      'test:e2e',
      ...pendingFiles,
      ...parallelArgs,
      '--reporter=default',
      '--reporter=json',
      '--outputFile=' + reportPath,
    ]
    const begin = Date.now()
    const result = spawnSync(browserCommand[0], browserCommand.slice(1), {
      stdio: 'inherit',
      env: { ...process.env, DSH_PHALANX_E2E_EVIDENCE_DIR: join(runDirectory, 'browser-failures') },
    })
    let status = result.status === 0 ? 'passed' : 'failed'
    let confirmationEvidence
    let finalReportPath = reportPath
    if (status === 'failed' && existsSync(reportPath)) {
      const confirmation = spawnSync(process.execPath, ['scripts/validation/retry-linux-cases.mjs', reportPath, '--without-containers'], {
        stdio: 'inherit',
        env: { ...process.env, DSH_PHALANX_VALIDATION_SOURCE_SHA: commit },
      })
      const ledgerPath = join(runDirectory, 'browser-retries.json')
      const confirmedPath = join(runDirectory, 'browser-confirmed.json')
      confirmationEvidence = {
        firstReport: reportPath,
        ...(existsSync(ledgerPath) ? { ledger: ledgerPath } : {}),
        ...(existsSync(confirmedPath) ? { confirmedReport: confirmedPath } : {}),
      }
      if (confirmation.status === 0 && existsSync(confirmedPath)) {
        status = 'passed'
        finalReportPath = confirmedPath
      }
    }
    let completenessReason
    if (status === 'passed') {
      const finalReport = readJsonIfExists(finalReportPath)
      const check = verifyBrowserReportCompleteness(finalReport, pendingFiles, root)
      if (!check.complete) {
        status = 'failed'
        completenessReason = check.reason
        console.error(`Browser report failed completeness check: ${check.reason}`)
      }
    }
    browserStageConfirmation = confirmationEvidence
    record.stages.push({
      name,
      status,
      durationMs: Date.now() - begin,
      reusedFiles: reusedFiles.length,
      executedFiles: pendingFiles.length,
      ...(confirmationEvidence ? { confirmation: confirmationEvidence } : {}),
      ...(completenessReason ? { error: completenessReason } : {}),
    })
    if (status !== 'passed') {
      record.status = 'failed'
      break
    }
    continue
  }
  const begin = Date.now()
  const result = spawnSync(command[0], command.slice(1), {
    stdio: 'inherit',
    env: { ...process.env, DSH_PHALANX_E2E_EVIDENCE_DIR: join(runDirectory, 'browser-failures') },
  })
  const status = result.status === 0 ? 'passed' : 'failed'
  record.stages.push({ name, status, durationMs: Date.now() - begin })
  if (status !== 'passed') {
    record.status = 'failed'
    break
  }
}
record.totalMs = Date.now() - started
record.status = record.status === 'running' ? 'passed' : record.status
record.clean = clean && git(['rev-parse', 'HEAD']) === commit && git(['status', '--porcelain']) === '' && inputDigest() === digest
writeJsonAtomic(join(runDirectory, 'summary.json'), record)
if (record.clean) {
  writeJsonAtomic(join(directory, commit + '.json'), record)
  const browserStage = record.stages.find(row => row.name === 'browser' && row.status === 'passed')
  if (browserStage && cached && !browserReusedWhole) {
    const wholeCommit = browserPendingFiles.length > 0 ? commit : (browserStage.reusedFrom ?? 'per-file-cache')
    const allConfirmations = [...browserConfirmations, ...(browserPendingFiles.length > 0 && browserStageConfirmation ? [browserStageConfirmation] : [])]
    const wholeConfirmation = allConfirmations.length === 1 ? allConfirmations[0] : allConfirmations.length > 1 ? allConfirmations : undefined
    writeJsonAtomic(cached, {
      commit: wholeCommit,
      clean: true,
      status: 'passed',
      inputDigest: digest,
      ...(wholeConfirmation ? { confirmation: wholeConfirmation } : {}),
    })
    if (fileDigests && browserPendingFiles.length > 0) {
      for (const file of browserPendingFiles) {
        const fileDigest = fileDigests.get(file)
        if (!fileDigest) continue
        writeJsonAtomic(join(browserFileCacheDir, `${fileDigest}.json`), {
          commit,
          clean: true,
          status: 'passed',
          file,
          inputDigest: fileDigest,
          ...(browserStageConfirmation ? { confirmation: browserStageConfirmation } : {}),
        })
      }
    }
  }
}
console.log(`Local check ${commit}: ${record.status}; ${record.totalMs}ms; clean evidence=${record.clean}`)
for (const row of record.stages) console.log(`  ${row.name}: ${row.status}, ${row.durationMs}ms${row.reusedFrom ? ', reused from ' + row.reusedFrom : ''}`)
console.log(`Receipt: ${join(runDirectory, 'summary.json')}`)
process.exitCode = record.status === 'passed' ? 0 : 1
