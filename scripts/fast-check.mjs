#!/usr/bin/env node
// Daily fast check: every seam-A use case and unit test, typecheck, lint
// (including all community architecture gates) and both builds, sequentially,
// against a 5-minute budget. Timing starts when this command starts and ends
// when the last stage ends; dependency installation is outside the budget.
// A clean-tree pass is recorded per commit as candidate evidence for the
// final-acceptance preconditions.
import { spawn, spawnSync } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { cpus, homedir, totalmem } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { FAST_CHECK_BUDGET_MS, fastCheckConfigurationDigest,
  fastCheckEvidenceDigest, fastCheckStageDigest } from './fast-check-policy.mjs'
import { trackedEvidenceInputs } from './fast-check-inputs.mjs'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const stateRoot = process.env.DSH_PHALANX_VALIDATION_STATE_ROOT ?? join(homedir(), '.local/state/dsh-phalanx-validation')
const STAGES = [
  ['typecheck', ['corepack', 'pnpm', 'typecheck']],
  ['lint', ['corepack', 'pnpm', 'lint']],
  ['unit', ['corepack', 'pnpm', 'test']],
  ['build', ['corepack', 'pnpm', 'build']],
  ['admin-build', ['corepack', 'pnpm', 'build:admin-ui']],
]

/** @returns the trimmed output, or undefined when git itself fails. */
const git = args => {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' })
  return result.status === 0 ? result.stdout.trim() : undefined
}
const run = async args => await new Promise(resolvePromise => {
  const child = spawn(args[0], args.slice(1), { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] })
  let tail = ''
  const keep = chunk => {
    process.stdout.write(chunk)
    tail = `${tail}${String(chunk)}`.slice(-4000)
  }
  child.stdout.on('data', keep)
  child.stderr.on('data', keep)
  child.once('error', error => resolvePromise({ code: 1, tail: error.message }))
  child.once('close', code => resolvePromise({ code, tail }))
})

const started = Date.now()
const commit = git(['rev-parse', 'HEAD'])
const clean = commit !== undefined && git(['status', '--porcelain']) === ''
const imageReference = process.env.DSH_PHALANX_CONTAINER_IMAGE
const imageId = imageReference === undefined ? 'unbound-image' : (() => {
  const result = spawnSync(process.env.DSH_PHALANX_CONTAINER_RUNTIME ?? 'podman',
    ['image', 'inspect', imageReference, '--format', '{{.Id}}'], { encoding: 'utf8' })
  if (result.status !== 0 || result.stdout.trim() === '') throw new Error('fast-check image identity is unavailable')
  return result.stdout.trim()
})()
const configurationDigest = fastCheckConfigurationDigest({
  nodeVersion: process.version, platform: process.platform, arch: process.arch,
  maxWorkers: process.env.DSH_PHALANX_VALIDATION_MAX_WORKERS ?? 'default',
})
const currentEvidenceInputs = () => ({
  ...trackedEvidenceInputs(root), imageId, configDigest: configurationDigest,
})
const evidenceInputs = clean ? currentEvidenceInputs() : undefined
const currentInputDigest = () => fastCheckEvidenceDigest(currentEvidenceInputs())
const inputDigest = evidenceInputs === undefined ? undefined : fastCheckEvidenceDigest(evidenceInputs)
const stageDirectory = join(stateRoot, 'fast-check', 'stages')
const record = {
  commit, clean, inputDigest, imageId, configurationDigest,
  status: 'running', budgetMs: FAST_CHECK_BUDGET_MS, startedAt: new Date(started).toISOString(), stages: [],
  machine: { platform: process.platform, arch: process.arch, cpu: cpus()[0]?.model ?? 'unknown', cpus: cpus().length,
    memoryGiB: Math.round(totalmem() / 2 ** 30), node: process.version },
}
for (const [name, args] of STAGES) {
  const stageDigest = evidenceInputs === undefined ? undefined : fastCheckStageDigest(evidenceInputs, name)
  const stageFile = stageDigest === undefined ? undefined : join(stageDirectory, `${name}-${stageDigest}.json`)
  const prior = stageFile === undefined ? undefined : await readFile(stageFile, 'utf8').then(value => {
    try { return JSON.parse(value) } catch { return undefined }
  }, () => undefined)
  if (prior?.status === 'passed' && prior.clean === true && prior.inputDigest === stageDigest) {
    record.stages.push({ name, status: 'passed', durationMs: 0, inputDigest: stageDigest, reused: true })
    process.stdout.write(`[fast-check] ${name} reused from input ${stageDigest}\n`)
    continue
  }
  const stageStarted = Date.now()
  process.stdout.write(`[fast-check] ${name} started\n`)
  const result = await run(args)
  const durationMs = Date.now() - stageStarted
  record.stages.push({ name, status: result.code === 0 ? 'passed' : 'failed', durationMs,
    ...(stageDigest === undefined ? {} : { inputDigest: stageDigest }) })
  process.stdout.write(`[fast-check] ${name} ${result.code === 0 ? 'passed' : 'failed'} (${durationMs} ms)\n`)
  if (result.code !== 0) {
    record.status = 'failed'
    // Classify on the first error line, not on arbitrary log output around it.
    const errorLine = result.tail.split('\n').find(line => /^\s*(?:\w*Error|FAIL)\b/u.test(line)) ?? ''
    record.firstFailure = { stage: name, message: errorLine }
    break
  }
}
record.totalMs = Date.now() - started
if (record.status === 'running') record.status = record.totalMs <= FAST_CHECK_BUDGET_MS ? 'passed' : 'over-budget'
process.stdout.write(`[fast-check] ${record.status} in ${record.totalMs} ms (budget ${FAST_CHECK_BUDGET_MS} ms)\n`)
for (const stage of record.stages) process.stdout.write(`[fast-check]   ${stage.name.padEnd(12)} ${String(stage.durationMs).padStart(7)} ms  ${stage.status}\n`)
// Candidate evidence must describe exactly one unchanged commit.
if (clean && git(['rev-parse', 'HEAD']) === commit && git(['status', '--porcelain']) === ''
  && currentInputDigest() === inputDigest) {
  const directory = join(stateRoot, 'fast-check')
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await mkdir(stageDirectory, { recursive: true, mode: 0o700 })
  for (const stage of record.stages.filter(item => item.status === 'passed')) {
    await writeFile(join(stageDirectory, `${stage.name}-${stage.inputDigest}.json`),
      `${JSON.stringify({ commit, clean, name: stage.name, inputDigest: stage.inputDigest,
        status: 'passed', durationMs: stage.durationMs }, null, 2)}\n`, { mode: 0o600 })
  }
  await writeFile(join(directory, `${commit}.json`), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 })
  await writeFile(join(directory, `${inputDigest}.json`), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 })
  process.stdout.write(`[fast-check] recorded for input ${inputDigest}\n`)
} else {
  process.stdout.write('[fast-check] working tree is dirty or changed; the result is not recorded as candidate evidence\n')
}
process.exitCode = record.status === 'passed' ? 0 : 1
