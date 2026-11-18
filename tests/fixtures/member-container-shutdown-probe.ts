import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** Instrument the real Podman command used by one isolated platform fixture. */
export async function memberContainerShutdownProbe(root: string, podman: string, ownership: string) {
  const runtime = join(root, 'podman-probe'),
    scenario = join(root, 'shutdown-scenario'),
    receipt = join(root, 'shutdown-receipt'),
    launchLock = join(root, 'shutdown-launch-lock'),
    launchReceipt = join(root, 'shutdown-launch-receipt')
  const script = `#!${process.execPath}
const { spawn, spawnSync } = require('node:child_process')
const { appendFileSync, existsSync, lstatSync, readFileSync } = require('node:fs')
const assert = require('node:assert/strict')
const podman = ${JSON.stringify(podman)}
const scenario = ${JSON.stringify(scenario)}
const receipt = ${JSON.stringify(receipt)}
const launchLock = ${JSON.stringify(launchLock)}
const launchReceipt = ${JSON.stringify(launchReceipt)}
const ownership = ${JSON.stringify(ownership)}
const args = process.argv.slice(2)
const mode = existsSync(scenario) ? readFileSync(scenario, 'utf8') : ''
const run = (args, options) => spawnSync(podman, args, { encoding: 'utf8', timeout: 20000, ...options })
const inspect = (target, format) => {
  const result = run(['inspect', '--format', format, target])
  assert.equal(result.status, 0, result.stderr)
  return result.stdout.trim()
}
const confirmOwner = target => {
  const [owner, writerHome] = JSON.parse(inspect(target, '[{{json (index .Config.Labels "dsh-phalanx.community-root")}},{{json (index .Config.Labels "dsh-phalanx.profile-writer-home")}}]'))
  assert.equal(owner, ownership)
  return !!writerHome
}
if (args[0] === 'port' && mode.startsWith('startup-')) {
  confirmOwner(args[1])
  process.stderr.write('validation fixture withheld the published port\\n')
  process.exit(1)
}
// A new DSH process may acquire its own lock immediately after launch.
if (args[0] === 'run' && (args.includes('--rm') || args.includes('--detach')) && args.includes('dsh-phalanx.community-root=' + ownership)
    && mode === 'restart-timeout' && args.includes('dsh-phalanx.user=' + mode)) {
  const launch = args.includes('--detach') ? 'instance' : 'configuration'
  const lockPath = readFileSync(launchLock, 'utf8')
  let present = true
  try {
    lstatSync(lockPath)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    present = false
  }
  appendFileSync(launchReceipt, JSON.stringify({ launch, present }) + '\\n')
}
if (args[0] === 'stop' && mode) {
  const target = args.at(-1)
  assert.match(target, /^[a-f0-9]{64}$/)
  const claimedWriter = confirmOwner(target)
  const seconds = Number(args[args.indexOf('--time') + 1])
  assert.ok(seconds > 0 && args.includes('--ignore'))
  if (mode.endsWith('-timeout') || mode === 'restart-shared') {
    const frozen = run(['kill', '--signal', 'STOP', target])
    assert.equal(frozen.status, 0, frozen.stderr)
  }
  const started = performance.now()
  const result = run(args, { stdio: 'inherit' })
  assert.equal(result.status, 0)
  const elapsed = performance.now() - started
  const [state, code] = inspect(target, '{{.State.Status}} {{.State.ExitCode}}').split(' ')
  appendFileSync(receipt, JSON.stringify({ mode, target, seconds, elapsed, state, code: Number(code), claimedWriter }) + '\\n')
  process.exit(0)
}
const child = spawn(podman, args, { stdio: 'inherit' })
process.once('SIGTERM', () => child.kill('SIGTERM'))
child.on('error', error => { console.error(error.message); process.exitCode = 1 })
child.on('exit', code => { process.exitCode = code ?? 1 })
`
  await writeFile(runtime, script, { mode: 0o700 })
  return { runtime, scenario, receipt, launchLock, launchReceipt }
}
