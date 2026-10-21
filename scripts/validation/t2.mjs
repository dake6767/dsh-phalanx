import { readFileSync, mkdirSync, openSync, closeSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { shardPlan, plan } from './t2-plan.mjs'
import { record } from './t2-shards.mjs'
import { verifyMigration } from './verify-linux-results.mjs'

const selection = JSON.parse(readFileSync(new URL('./t2-selection.json', import.meta.url), 'utf8'))
const args = process.argv.slice(2)
if (args[0] === '--list') {
  console.log(JSON.stringify(selection, null, 2))
  process.exit(0)
}
await import('./check-tiers.mjs')
const smoke = args[0] === '--smoke'
if (smoke) args.shift()
const fileIndex = args.indexOf('--files')
let files = fileIndex < 0 ? undefined : args.splice(fileIndex, 2)[1]?.split(',')
if (fileIndex >= 0 && (!files?.length || smoke || new Set(files).size !== files.length || files.some(file => !selection.regular.includes(file)))) throw new Error('Select distinct regular T2 inventory files')
const shardIndex = args.indexOf('--shard')
const shard = shardIndex < 0 ? undefined : shardPlan(args.splice(shardIndex, 2)[1])
if (shard && (smoke || files)) throw Error('Shard, smoke and file subset modes are mutually exclusive')
if (shard) files = shard.files
if (args.length !== 1) throw new Error('Usage: node scripts/validation/t2.mjs [--smoke | --files FILE,FILE | --shard INDEX/4] RESULTS_DIRECTORY')
if (process.platform !== 'linux' || process.getuid() === 0) throw new Error('Run T2 as the rootless Linux test identity')
for (const key of ['DSH_PHALANX_CONTAINER_IMAGE', 'DSH_PHALANX_PRECHECK_IMAGE', 'DSH_PHALANX_INSTALL_ROOT', 'DSH_PHALANX_CANDIDATE_SHA']) {
  if (!process.env[key]) throw new Error(`T2 requires ${key}; no missing-input skips are permitted`)
}
const directory = resolve(args[0])
mkdirSync(directory, { recursive: true })
mkdirSync(join(directory, 'browser-failures'), { recursive: true })
function batch(name, files, extra = []) {
  const log = openSync(join(directory, `${name}.log`), 'w')
  try {
    console.log(`T2 ${name}: ${files.length} files; log ${join(directory, `${name}.log`)}`)
    const result = spawnSync(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', '--config', 'vitest.e2e.config.ts',
      ...files, ...extra, '--reporter=default', '--reporter=json', `--outputFile=${join(directory, `${name}.json`)}`],
    { stdio: ['ignore', log, log], env: { ...process.env, DSH_PHALANX_E2E_EVIDENCE_DIR: join(directory, 'browser-failures') } })
    if (result.error) throw result.error
    if (result.status === 0) return join(directory, `${name}.json`)
    const confirmation = spawnSync(process.execPath, ['scripts/validation/retry-linux-cases.mjs', join(directory, `${name}.json`)], { stdio: 'inherit' })
    if (confirmation.error) throw confirmation.error
    return confirmation.status === 0 ? join(directory, `${name}-confirmed.json`) : undefined
  } finally { closeSync(log) }
}
if (smoke) {
  const smokeReport = batch('smoke', selection.smoke)
  if (!smokeReport) throw new Error('Native arm64 smoke failed; inspect smoke.log')
  const report = JSON.parse(readFileSync(smokeReport, 'utf8'))
  if (!report.success || report.numPassedTests !== 6 || report.numPendingTests !== 0 || report.numFailedTests !== 0 ||
      report.testResults.length !== 5 || report.testResults.flatMap(file => file.assertionResults).some(row => row.status !== 'passed')) {
    throw new Error('All six native arm64 smoke cases must run and pass')
  }
  console.log('Six native arm64 smoke cases passed.')
} else if (files) {
  const regular = batch('linux', files)
  if (!regular) throw new Error('T2 subset failed; inspect linux.log')
  const result = spawnSync(process.execPath, ['scripts/validation/verify-linux-results.mjs', regular, '-', '--files', files.join(',')], { stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error('T2 subset result contract failed')
  let migration
  if (shard?.migration) {
    migration = batch('migration', [selection.migration.file], ['-t', selection.migration.selected])
    if (!migration) throw Error('Shard migration failed')
    verifyMigration(JSON.parse(readFileSync(migration, 'utf8')))
  }
  if (process.env.DSH_PHALANX_T2_IDENTITY) record(directory, shard ?? plan(files).shards[0],
    JSON.parse(readFileSync(process.env.DSH_PHALANX_T2_IDENTITY, 'utf8')), regular, migration)
} else {
  const regular = batch('linux', selection.regular)
  const migration = batch('migration', [selection.migration.file], ['-t', selection.migration.selected])
  if (!regular || !migration) throw new Error('T2 failed; inspect linux.log and migration.log')
  const result = spawnSync(process.execPath, ['scripts/validation/verify-linux-results.mjs', regular, migration], { stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error('T2 result contract failed')
}
