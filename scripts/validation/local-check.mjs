// The complete local layer: original fast-check budget, docs and controlled browser files.
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { trackedEvidenceInputs } from '../fast-check-inputs.mjs'
import { evidenceInputDigest, fastCheckConfigurationDigest } from '../fast-check-policy.mjs'

if (process.argv.length !== 2) throw Error('Usage: node scripts/validation/local-check.mjs')
const git = args => {
  const result = spawnSync('git', args, { encoding: 'utf8' })
  if (result.status !== 0) throw Error('Cannot determine local check source identity')
  return result.stdout.trim()
}
const files = JSON.parse(readFileSync(new URL('./local-browser-files.json', import.meta.url), 'utf8'))
const root = process.cwd(), commit = git(['rev-parse', 'HEAD'])
const clean = git(['status', '--porcelain']) === ''
const state = process.env.DSH_PHALANX_VALIDATION_STATE_ROOT ?? join(homedir(), '.local/state/dsh-phalanx-validation')
const directory = join(state, 'local-check')
mkdirSync(directory, { recursive: true, mode: 0o700 })
const started = Date.now(), runDirectory = join(directory, 'runs', `${started}-${process.pid}`)
mkdirSync(runDirectory, { recursive: true, mode: 0o700 })
const configDigest = fastCheckConfigurationDigest({ nodeVersion: process.version, platform: process.platform, arch: process.arch, maxWorkers: '1' })
const inputDigest = () => evidenceInputDigest({ ...trackedEvidenceInputs(root), configDigest, imageId: 'controlled-browser-no-image' }, files)
const digest = clean ? inputDigest() : undefined
const cached = digest ? join(directory, 'browser-' + digest + '.json') : undefined
const record = { protocol: 'local-check-v1', commit, clean, status: 'running', startedAt: new Date(started).toISOString(), stages: [], directory: runDirectory }
const stages = [
  ['fast-check', [process.execPath, 'scripts/fast-check.mjs']],
  ['documentation', ['corepack', 'pnpm', 'docs:check']],
  ['browser', ['corepack', 'pnpm', 'test:e2e', ...files, '--maxWorkers=1', '--reporter=default', '--reporter=json', '--outputFile=' + join(runDirectory, 'browser.json')]],
]
for (const [name, command] of stages) {
  const prior = name === 'browser' && cached && existsSync(cached) ? JSON.parse(readFileSync(cached, 'utf8')) : undefined
  if (prior?.status === 'passed' && prior.inputDigest === digest && prior.clean === true) {
    record.stages.push({ name, status: 'passed', durationMs: 0, reusedFrom: prior.commit }); continue
  }
  const begin = Date.now()
  const result = spawnSync(command[0], command.slice(1), { stdio: 'inherit', env: { ...process.env,
    DSH_PHALANX_E2E_EVIDENCE_DIR: join(runDirectory, 'browser-failures') } })
  let status = result.status === 0 ? 'passed' : 'failed'
  let confirmationEvidence
  if (name === 'browser' && status === 'failed' && existsSync(join(runDirectory, 'browser.json'))) {
    const confirmation = spawnSync(process.execPath, ['scripts/validation/retry-linux-cases.mjs', join(runDirectory, 'browser.json'), '--without-containers'], { stdio: 'inherit' })
    confirmationEvidence = { firstReport: join(runDirectory, 'browser.json'), ledger: join(runDirectory, 'browser-retries.json'), confirmedReport: join(runDirectory, 'browser-confirmed.json') }
    if (confirmation.status === 0) status = 'passed'
  }
  record.stages.push({ name, status, durationMs: Date.now() - begin, ...(confirmationEvidence ? { confirmation: confirmationEvidence } : {}) })
  if (status !== 'passed') { record.status = 'failed'; break }
}
record.totalMs = Date.now() - started
record.status = record.status === 'running' ? 'passed' : record.status
record.clean = clean && git(['rev-parse', 'HEAD']) === commit && git(['status', '--porcelain']) === '' && inputDigest() === digest
writeFileSync(join(runDirectory, 'summary.json'), JSON.stringify(record, null, 2) + '\n', { mode: 0o600 })
if (record.clean) {
  writeFileSync(join(directory, commit + '.json'), JSON.stringify(record, null, 2) + '\n', { mode: 0o600 })
  if (record.stages.some(row => row.name === 'browser' && row.status === 'passed') && cached) {
    writeFileSync(cached, JSON.stringify({ commit, clean: true, status: 'passed', inputDigest: digest }) + '\n', { mode: 0o600 })
  }
}
console.log(`Local check ${commit}: ${record.status}; ${record.totalMs}ms; clean evidence=${record.clean}`)
for (const row of record.stages) console.log(`  ${row.name}: ${row.status}, ${row.durationMs}ms${row.reusedFrom ? ', reused from ' + row.reusedFrom : ''}`)
console.log(`Receipt: ${join(runDirectory, 'summary.json')}`)
process.exitCode = record.status === 'passed' ? 0 : 1
