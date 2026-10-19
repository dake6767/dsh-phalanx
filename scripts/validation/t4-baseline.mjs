// Formal baseline snapshots for T4 stages: install the formal previous release
// once on a pristine Ubuntu cloud image, keep the result as a read-only qcow2
// base with a creation receipt, and boot every stage from its own overlay with
// a one-time injected SSH identity. The snapshot holds no validation credentials
// or install-time login keys; it keeps the instance secrets the formal installer
// generated, so its store stays private to the validation user.
import { spawn, spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { chmod, copyFile, mkdir, readdir, readFile, rename, rm, stat, statfs, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const VALIDATOR_USER = 'validator'
export const GUEST_SERVICE_PORT = 18080
// A 2 GiB guest under software emulation measured about 3.2 GiB resident; keep
// the host floor above that plus headroom, and never run a second VM.
export const MEMORY_FLOOR_MIB = 5000
export const PREPARE_DISK_GIB = 20
export const STAGE_DISK_GIB = 10
export const ISO_TOOLS = ['cloud-localds', 'genisoimage', 'mkisofs', 'xorriso']
export const PRESETS = ['mainland', 'official']
// QEMU user networking's address for the host, as seen from the guest.
export const QEMU_HOST_ADDRESS = '10.0.2.2'
const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/u

const SHA256 = /^[0-9a-f]{64}$/u
const TAG = /^v\d+\.\d+\.\d+$/u

/** Structural validation; a parsed nonzero-exit receipt still fails verifyBaseline. */
export function parseBaselineReceipt(value) {
  if (value === null || typeof value !== 'object') throw new Error('Baseline receipt is not an object')
  const receipt = value
  if (receipt.schema !== 1) throw new Error(`Unsupported baseline receipt schema ${String(receipt.schema)}`)
  if (typeof receipt.tag !== 'string' || !TAG.test(receipt.tag)) throw new Error(`Invalid formal tag in receipt: ${String(receipt.tag)}`)
  if (typeof receipt.commit !== 'string' || !/^[0-9a-f]{40}$/u.test(receipt.commit)) throw new Error('Receipt commit is not a 40-hex sha')
  if (receipt.ubuntu === null || typeof receipt.ubuntu !== 'object' || typeof receipt.ubuntu.image !== 'string' || receipt.ubuntu.image === '' || !SHA256.test(receipt.ubuntu.sha256 ?? ''))
    throw new Error('Receipt must record the Ubuntu cloud image name and its sha256')
  if (typeof receipt.installSeconds !== 'number' || receipt.installSeconds < 0 || (receipt.exitCode !== null && !(receipt.installSeconds > 0))) throw new Error('Receipt must record a positive install duration once the install ran')
  if (receipt.exitCode !== null && !Number.isInteger(receipt.exitCode)) throw new Error('Receipt must record an integer install exit code, or null before the install ran')
  if (receipt.preset !== undefined && !PRESETS.includes(receipt.preset)) throw new Error(`Unknown download preset in receipt: ${String(receipt.preset)}`)
  if (receipt.harness !== undefined && (!/^[0-9a-f]{40}$/u.test(receipt.harness?.commit ?? '') || !SHA256.test(receipt.harness?.scriptSha256 ?? ''))) throw new Error('Receipt harness must record its commit and script sha256')
  if (receipt.exitCode === 0) {
    if (!SHA256.test(receipt.platformSha256 ?? '')) throw new Error('Successful receipt must record the formal platform sha256')
    if (typeof receipt.imageDigest !== 'string' || !/^sha256:[0-9a-f]{64}$/u.test(receipt.imageDigest)) throw new Error('Successful receipt must record the formal image digest')
    if (receipt.base === null || typeof receipt.base !== 'object') throw new Error('Successful receipt must describe its base file')
    if (typeof receipt.base.path !== 'string' || receipt.base.path.includes('/') || !receipt.base.path.endsWith('.qcow2')) throw new Error('Receipt base path must be a file name inside the store')
    if (!SHA256.test(receipt.base.sha256 ?? '')) throw new Error('Receipt must record the base file sha256')
    if (!Number.isSafeInteger(receipt.base.bytes) || receipt.base.bytes <= 0) throw new Error('Receipt must record a positive base size')
  }
  return receipt
}

/** A stage may boot the base only when the receipt is a success and the file hash still matches it. */
export function verifyBaseline(receipt, actualBaseSha256) {
  const parsed = parseBaselineReceipt(receipt)
  const ok = parsed.exitCode === 0 && parsed.base.sha256 === actualBaseSha256
  return { ok, expected: parsed.base?.sha256, actual: actualBaseSha256, reinstall: !ok }
}

/** NoCloud seed content: only the public key ever enters the guest. */
export function cloudInitSeed({ instanceId, publicKey, user = VALIDATOR_USER }) {
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/u.test(instanceId)) throw new Error(`Invalid cloud-init instance id: ${instanceId}`)
  if (typeof publicKey !== 'string' || !/^ssh-/u.test(publicKey) || publicKey.includes('\n')) throw new Error('A single SSH public key line is required')
  return {
    'user-data': `#cloud-config\nssh_pwauth: false\nusers:\n  - default\n  - name: ${user}\n    sudo: ALL=(ALL) NOPASSWD:ALL\n    shell: /bin/bash\n    lock_passwd: true\n    ssh_authorized_keys:\n      - ${publicKey}\n`,
    'meta-data': `instance-id: ${instanceId}\nlocal-hostname: dsh-baseline\n`,
  }
}

/** A NoCloud instance id from a formal tag or a stage name; a fresh suffix makes cloud-init treat every boot as a new instance. */
export function instanceIdFor(kind, label, suffix = randomUUID().slice(0, 8)) {
  const id = `${kind}-${String(label).replace(/^v/u, '').replace(/[^A-Za-z0-9-]/gu, '-')}-${suffix}`.slice(0, 64)
  cloudInitSeed({ instanceId: id, publicKey: 'ssh-ed25519 check' })
  return id
}

/** Build the seed ISO with whichever NoCloud-capable tool the validation host has. */
export function resolveIsoTool(available) {
  return ISO_TOOLS.find(tool => available.includes(tool))
}

export function seedCommand(tool, seedPath) {
  switch (tool) {
    case 'cloud-localds': return ['cloud-localds', seedPath, 'user-data', 'meta-data']
    case 'genisoimage': case 'mkisofs': return [tool, '-output', seedPath, '-volid', 'cidata', '-joliet', '-rock', 'user-data', 'meta-data']
    case 'xorriso': return ['xorriso', '-as', 'mkisofs', '-output', seedPath, '-volid', 'cidata', '-joliet', '-rock', 'user-data', 'meta-data']
    default: throw new Error(`No NoCloud seed tool among: ${ISO_TOOLS.join(', ')}`)
  }
}

/** Each stage owns a private copy-on-write disk; nothing it does reaches the base. */
export function overlayCreateArgs(base, overlay) {
  return ['create', '-f', 'qcow2', '-b', base, '-F', 'qcow2', overlay]
}

export function qemuArgs({ overlay, seed, sshPort, memoryMib = 2048, processors = 2, forwards = [], pidFile, serialLog }) {
  const hostForwards = [`hostfwd=tcp:127.0.0.1:${sshPort}-:22`, ...forwards.map(forward => `hostfwd=tcp:127.0.0.1:${forward.host}-:${forward.guest}`)]
  return ['qemu-system-x86_64', '-accel', 'tcg', '-cpu', 'max', '-smp', String(processors), '-m', String(memoryMib),
    '-drive', `file=${overlay},format=qcow2,if=virtio`, '-drive', `file=${seed},format=raw,if=virtio,readonly=on`,
    '-netdev', `user,id=net0,${hostForwards.join(',')}`, '-device', 'virtio-net-pci,netdev=net0',
    '-display', 'none', '-serial', `file:${serialLog}`, '-pidfile', pidFile, '-daemonize']
}

/** The formal installer runs inside the guest exactly as the formal release ships it. */
export function formalInstallCommand(installer, tag, preset = 'mainland') {
  if (!TAG.test(tag) || !PRESETS.includes(preset) || !/^\/[A-Za-z0-9/_.-]+$/u.test(installer)) throw new Error('Formal install needs a vX.Y.Z tag, a known preset and an absolute installer path')
  return `sudo -n bash ${installer} --version ${tag} --download-source-preset ${preset} --host-public-addresses '' --listen-address 0.0.0.0 --port ${GUEST_SERVICE_PORT} --public-origin http://127.0.0.1:${GUEST_SERVICE_PORT} --verbose --output json`
}

/** The installer's own report is the receipt's identity source and must match the formal acceptance record. */
export function installIdentity(output, record) {
  if (output.status !== 'installed') throw new Error(`Formal install reported status ${String(output.status)}`)
  if (output.changed !== true) throw new Error('Formal install reported no change; the baseline was not pristine')
  const mismatches = [['commit', output.commit, record.commit], ['platformSha256', output.platformSha256, record.platformSha256], ['imageDigest', output.imageDigest, record.imageDigest]]
    .filter(([, actual, expected]) => actual !== expected)
  if (mismatches.length) throw new Error(`Installed identity differs from the formal acceptance record: ${mismatches.map(([field]) => field).join(', ')}`)
  return { commit: output.commit, platformSha256: output.platformSha256, imageDigest: output.imageDigest }
}

/** Strip every install-time login path before the overlay becomes the read-only base. */
export function resealCommands(user = VALIDATOR_USER) {
  return [
    // Each overlay must boot as a distinct host: acceptance resume binds its progress to /etc/machine-id.
    'sudo -n cloud-init clean --logs --machine-id',
    'sudo -n find /var/lib/cloud -type f -name authorized_keys -delete',
    `sudo -n rm -f /home/${user}/.ssh/authorized_keys /root/.ssh/authorized_keys`,
    'sudo -n sync',
  ]
}

/** Removing authorized_keys ends every later login, so the reseal and power-off run in one session. */
export function resealScript(user = VALIDATOR_USER) {
  return ['set -eu', ...resealCommands(user), '(sleep 2; sudo -n systemctl poweroff) >/dev/null 2>&1 &'].join('\n') + '\n'
}

/** SSH answers before the user service does; a stage is ready only once the installed entry serves its login page. */
export function serviceReadyCommand(timeoutSeconds = 600) {
  return `for i in $(seq 1 ${Math.ceil(timeoutSeconds / 5)}); do [ "$(curl -s --max-time 10 -o /dev/null -w '%{http_code}' http://127.0.0.1:${GUEST_SERVICE_PORT}/login)" = 200 ] && exit 0; sleep 5; done; exit 1`
}

export function availableMemoryMib(meminfo) {
  const kib = /^MemAvailable:\s+(\d+) kB$/mu.exec(meminfo)?.[1]
  if (kib === undefined) throw new Error('MemAvailable is missing from /proc/meminfo')
  return Number(kib) / 1024
}

export function availableDiskGib({ bsize, bavail }) {
  return bsize * bavail / 2 ** 30
}

export function storePaths(store, tag) {
  return { base: join(store, `formal-${tag}.qcow2`), receipt: join(store, `formal-${tag}.receipt.json`) }
}

const CLI_SPEC = {
  prepare: { required: ['store', 'ubuntu-image', 'ubuntu-sha256', 'tag', 'source'], optional: ['disk-gib', 'memory-mib', 'ssh-port', 'preset', 'replace-corrupt', 'harness-commit'] },
  stage: { required: ['store', 'tag', 'name'], optional: ['ssh-port', 'work-dir', 'forward'] },
  end: { required: ['store', 'name'], optional: ['work-dir', 'keep-disk'] },
  verify: { required: ['store', 'tag'], optional: [] },
}
const CLI_NAMES = { 'ubuntu-image': 'ubuntuImage', 'ubuntu-sha256': 'ubuntuSha256', 'ssh-port': 'sshPort', 'disk-gib': 'diskGib', 'memory-mib': 'memoryMib', 'work-dir': 'workDir', 'keep-disk': 'keepDisk', 'replace-corrupt': 'replaceCorrupt', 'harness-commit': 'harnessCommit' }
const FLAGS = ['keep-disk', 'replace-corrupt']

export function parseCli(argv) {
  const [command, ...rest] = argv
  const spec = CLI_SPEC[command]
  if (spec === undefined) throw new Error('Usage: t4-baseline.mjs prepare|stage|end|verify --store DIR [--tag vX.Y.Z] ...')
  const known = [...spec.required, ...spec.optional], options = {}, forwards = []
  for (let index = 0; index < rest.length; index += 1) {
    const option = rest[index]
    if (typeof option !== 'string' || !option.startsWith('--')) throw new Error(`Unexpected argument for ${command}: ${String(option)}`)
    const name = option.slice(2)
    if (!known.includes(name)) throw new Error(`Unknown option --${name} for ${command}`)
    if (FLAGS.includes(name)) { options[CLI_NAMES[name]] = true; continue }
    const value = rest[index += 1]
    if (value === undefined) throw new Error(`--${name} needs a value`)
    if (name === 'forward') forwards.push(value)
    else options[CLI_NAMES[name] ?? name] = value
  }
  const missing = spec.required.filter(name => options[CLI_NAMES[name] ?? name] === undefined)
  if (missing.length) throw new Error(`${command} requires --${missing.join(' --')}`)
  const port = value => /^\d+$/u.test(value) && Number(value) >= 1 && Number(value) <= 65535
  options.forwards = forwards.map(entry => {
    const [guest, host = guest, extra] = entry.split(':')
    if (extra !== undefined || !port(guest) || !port(host) || Number(guest) === 22 || Number(host) === 22) throw new Error(`--forward needs GUEST_PORT[:HOST_PORT] with the SSH port reserved, not ${entry}`)
    return { guest: Number(guest), host: Number(host) }
  })
  for (const [key, min, max] of [['diskGib', 16, 512], ['memoryMib', 1024, 16384], ['sshPort', 1024, 65535]]) {
    if (options[key] === undefined) continue
    if (!/^\d+$/u.test(options[key]) || Number(options[key]) < min || Number(options[key]) > max) throw new Error(`--${Object.keys(CLI_NAMES).find(name => CLI_NAMES[name] === key)} must be an integer from ${min} to ${max}`)
    options[key] = Number(options[key])
  }
  if (options.sshPort !== undefined && options.forwards.some(forward => forward.host === options.sshPort)) throw new Error('--ssh-port must differ from every forwarded host port')
  if (options.harnessCommit !== undefined && !/^[0-9a-f]{40}$/u.test(options.harnessCommit)) throw new Error('--harness-commit must be a full 40-hex commit')
  if (options.tag !== undefined && !TAG.test(options.tag)) throw new Error(`--tag needs a formal vX.Y.Z, not ${options.tag}`)
  if (options.name !== undefined && !SLUG.test(options.name)) throw new Error(`--name must be a short lowercase slug, not ${options.name}`)
  // qemu-img resolves a relative backing file against the overlay, and QEMU splits -drive on commas.
  for (const key of ['store', 'workDir', 'ubuntuImage', 'source']) if (options[key] !== undefined) {
    options[key] = resolve(options[key])
    if (options[key].includes(',')) throw new Error(`--${key} must not contain a comma: ${options[key]}`)
  }
  return { command, options }
}

const run = (file, args, options = {}) => {
  const result = spawnSync(file, args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, ...options })
  if (result.error) throw result.error
  return result
}
const checked = (file, args, options = {}) => {
  const result = run(file, args, options)
  if (result.status !== 0) throw new Error(`${[file, ...args].join(' ')} failed (${result.status}): ${String(result.stderr).trim()}`)
  return result.stdout
}
const exists = path => existsSync(path)

async function sha256File(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

export function sshArgs(key, port) {
  return ['-i', key, '-p', String(port), '-o', 'IdentitiesOnly=yes', '-o', 'UserKnownHostsFile=/dev/null', '-o', 'StrictHostKeyChecking=no',
    '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', '-o', 'ServerAliveInterval=30', '-o', 'ServerAliveCountMax=6', `${VALIDATOR_USER}@127.0.0.1`]
}

function sshOutput(key, port, command, input, acceptedExit = [0]) {
  return new Promise((resolve, reject) => {
    const child = spawn('ssh', [...sshArgs(key, port), command], { stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    child.stdout.on('data', data => { stdout += String(data) }); child.stderr.on('data', data => { stderr += String(data) })
    child.stdin.on('error', () => {})
    child.once('error', reject)
    child.once('close', code => {
      if (acceptedExit === 'any' || acceptedExit.includes(code)) resolve({ code, stdout, stderr })
      else reject(new Error(`ssh ${command} failed (${code}): ${stderr}`))
    })
    child.stdin.end(input)
  })
}

async function freePort() {
  return await new Promise((resolvePort, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolvePort(port)) })
  })
}

const lockPath = store => join(store, 'vm.lock')

/** A pid read from a file; 0 and 1 would signal this process group or init. */
export function parsePid(text, source) {
  const pid = Number(String(text).trim())
  if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error(`Invalid pid in ${source}`)
  return pid
}

const alive = pid => { try { process.kill(pid, 0); return true } catch { return false } }

/**
 * One software-emulated VM at a time: a second QEMU has exhausted the host before. The lock is
 * created atomically with this process's pid before any slow work, then handed to QEMU's pid.
 */
export function claimSingleVm(store) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try { writeFileSync(lockPath(store), `${process.pid}\n`, { flag: 'wx', mode: 0o600 }); return } catch (error) { if (error.code !== 'EEXIST') throw error }
    const holder = parsePid(readFileSync(lockPath(store), 'utf8'), lockPath(store))
    if (alive(holder)) throw new Error(`Another baseline VM is running (pid ${holder}); software emulation allows only one`)
    rmSync(lockPath(store), { force: true })
  }
  throw new Error(`Could not claim ${lockPath(store)}`)
}

async function recordRunningVm(store, pidFile) {
  await writeFile(lockPath(store), `${parsePid(await readFile(pidFile, 'utf8'), pidFile)}\n`, { mode: 0o600 })
}

/** Release only a lock this run or this stage holds, or one whose holder has gone. */
export function releaseVm(store, owners) {
  let holder
  try { holder = parsePid(readFileSync(lockPath(store), 'utf8'), lockPath(store)) } catch (error) { if (error.code === 'ENOENT') return; throw error }
  if (owners.includes(holder) || !alive(holder)) rmSync(lockPath(store), { force: true })
}

async function guardResources(store, diskFloorGib) {
  const memory = availableMemoryMib(readFileSync('/proc/meminfo', 'utf8'))
  if (memory < MEMORY_FLOOR_MIB) throw new Error(`Only ${Math.round(memory)} MiB available; a software-emulated VM needs ${MEMORY_FLOOR_MIB} MiB`)
  const free = availableDiskGib(await statfs(store))
  if (free < diskFloorGib) throw new Error(`Only ${free.toFixed(1)} GiB free in the store; this command reserves ${diskFloorGib} GiB`)
}

export function bootVm({ overlay, seed, workDir, sshPort, forwards, memoryMib }) {
  const pidFile = join(workDir, 'qemu.pid'), serialLog = join(workDir, 'serial.log')
  const [file, ...args] = qemuArgs({ overlay, seed, sshPort, memoryMib, forwards, pidFile, serialLog })
  checked(file, args)
  return { pidFile, serialLog }
}

/** The VM's pid, or undefined once QEMU has removed its pid file on exit. */
async function vmPid(pidFile) {
  try { return parsePid(await readFile(pidFile, 'utf8'), pidFile) } catch (error) { if (error.code === 'ENOENT') return undefined; throw error }
}

export async function waitVmExit(pidFile, timeoutMs, pollMs = 5000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const pid = await vmPid(pidFile)
    if (pid === undefined || !alive(pid)) return
    await sleep(pollMs)
  }
  throw new Error(`VM did not stop within ${timeoutMs / 60000} minutes (${pidFile})`)
}

/** Signal only the QEMU that runs this disk: a pid file left by a killed QEMU may name a reused pid. */
export function ownsVm(cmdline, overlay) {
  const args = String(cmdline).split('\0')
  return args[0]?.endsWith('qemu-system-x86_64') === true && args.some(argument => argument.startsWith(`file=${overlay},`))
}

async function stopVm(pidFile, overlay) {
  const pid = await vmPid(pidFile)
  if (pid === undefined || !alive(pid)) return
  let cmdline = ''
  try { cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf8') } catch { return }
  if (!ownsVm(cmdline, overlay)) throw new Error(`pid ${pid} in ${pidFile} is not the QEMU for ${overlay}; refusing to signal it`)
  process.kill(pid, 'SIGTERM')
  try { await waitVmExit(pidFile, 2 * 60_000) } catch {
    if (alive(pid)) try { process.kill(pid, 'SIGKILL') } catch (error) { if (error.code !== 'ESRCH') throw error }
    await waitVmExit(pidFile, 60_000)
  }
}

async function waitForSsh(key, port, workDir, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (run('ssh', [...sshArgs(key, port), 'true']).status === 0) return
    await sleep(5000)
  }
  throw new Error(`VM SSH did not come up within ${timeoutMs / 60000} minutes; see ${join(workDir, 'serial.log')}`)
}

export async function makeSeed(workDir, instanceId, publicKey) {
  const seed = join(workDir, 'seed.img')
  const files = cloudInitSeed({ instanceId, publicKey })
  for (const name of ['user-data', 'meta-data']) await writeFile(join(workDir, name), files[name])
  const tool = resolveIsoTool(ISO_TOOLS.filter(candidate => run('sh', ['-c', `command -v ${candidate}`]).status === 0))
  if (tool === undefined) throw new Error(`The validation host needs one of: ${ISO_TOOLS.join(', ')}`)
  const [file, ...args] = seedCommand(tool, seed)
  checked(file, args, { cwd: workDir })
  return seed
}


async function readReceipt(store, tag) {
  let text
  try { text = await readFile(storePaths(store, tag).receipt, 'utf8') } catch (error) {
    if (error.code === 'ENOENT') throw new Error(`No baseline receipt for ${tag} in ${store}; run prepare first`)
    throw error
  }
  const receipt = parseBaselineReceipt(JSON.parse(text))
  if (receipt.tag !== tag || receipt.base?.path !== basename(storePaths(store, tag).base)) throw new Error(`Receipt ${storePaths(store, tag).receipt} describes ${receipt.tag}/${receipt.base?.path}, not ${tag}`)
  return receipt
}

/** Verify the base against its receipt; a mismatch is reinstalled with `prepare --replace-corrupt`. */
async function verifyBase(store, tag) {
  const receipt = await readReceipt(store, tag)
  const verdict = verifyBaseline(receipt, await sha256File(storePaths(store, tag).base))
  if (!verdict.ok) throw new Error(`Baseline integrity failed for ${tag}: receipt ${verdict.expected ?? '(none)'}, file ${verdict.actual}; reinstall it with prepare --replace-corrupt`)
  return receipt
}

/** The store holds instance secrets from the formal install: it must not be reachable by other users. */
async function privateStore(store) {
  await mkdir(store, { recursive: true, mode: 0o700 })
  const facts = await stat(store)
  if (facts.uid !== process.getuid() || (facts.mode & 0o077) !== 0) throw new Error(`${store} must be owned by this user with mode 700`)
}

/** Development rule: keep only the most recent failed stage disk; the receipt is written before older disks go. */
async function keepOnlyLatestFailedDisk(store, keep) {
  const removed = []
  for (const name of await readdir(join(store, 'stages')).catch(() => [])) {
    const disk = join(store, 'stages', name, 'disk.qcow2')
    if (disk !== keep && exists(disk) && !exists(join(store, 'stages', name, 'qemu.pid'))) { await rm(disk, { force: true }); removed.push(disk) }
  }
  return removed
}

async function prepare(options) {
  const { store, tag, source } = options
  if (!TAG.test(tag)) throw new Error(`--tag needs a formal vX.Y.Z, not ${tag}`)
  const preset = options.preset ?? 'mainland'
  if (!PRESETS.includes(preset)) throw new Error(`--preset must be one of ${PRESETS.join(', ')}`)
  const diskGib = Number(options.diskGib ?? 32), memoryMib = Number(options.memoryMib ?? 2048)
  const { base, receipt: receiptPath } = storePaths(store, tag)
  await privateStore(store)
  if (exists(base)) {
    if (!options.replaceCorrupt) throw new Error(`${base} already exists; verify it, or reinstall a failed one with --replace-corrupt`)
    let intact = false
    try { await verifyBase(store, tag); intact = true } catch { /* only a base that fails verification is replaced */ }
    if (intact) throw new Error(`${base} verifies; --replace-corrupt only reinstalls a base that fails verification`)
  }
  const workDir = join(store, 'prepare')
  if (exists(join(workDir, 'disk.qcow2')))
    throw new Error(`A previous prepare left its disk in ${workDir}; record its failed-receipt.json, then remove that directory before preparing again`)
  claimSingleVm(store)
  let vm, step = 'resources'
  const receipt = { schema: 1, tag, preset, ubuntu: { image: basename(options.ubuntuImage), sha256: options.ubuntuSha256 }, exitCode: null, installSeconds: 0 }
  try {
    // A source snapshot without Git history names its commit explicitly.
    const commit = options.harnessCommit ?? checked('git', ['-C', dirname(fileURLToPath(import.meta.url)), 'rev-parse', 'HEAD']).trim()
    receipt.harness = { commit, scriptSha256: await sha256File(fileURLToPath(import.meta.url)) }
    await guardResources(store, PREPARE_DISK_GIB)
    // An earlier failure before its disk existed leaves only its receipt; keep it beside the store.
    if (exists(join(workDir, 'failed-receipt.json'))) await rename(join(workDir, 'failed-receipt.json'), join(store, `failed-prepare-${tag}-${Date.now()}.json`))
    await rm(workDir, { recursive: true, force: true })
    await mkdir(workDir, { mode: 0o700 })
    step = 'ubuntu-image'
    const ubuntuSha = await sha256File(options.ubuntuImage)
    if (ubuntuSha !== options.ubuntuSha256) throw new Error(`Ubuntu image sha256 ${ubuntuSha} does not match the given ${options.ubuntuSha256}`)
    const ubuntuBase = join(store, `ubuntu-${options.ubuntuSha256.slice(0, 12)}.qcow2`)
    if (exists(ubuntuBase) && await sha256File(ubuntuBase) !== options.ubuntuSha256) throw new Error(`Cached ${ubuntuBase} no longer matches ${options.ubuntuSha256}; remove it and prepare again`)
    if (!exists(ubuntuBase)) { await copyFile(options.ubuntuImage, `${ubuntuBase}.partial`); await chmod(`${ubuntuBase}.partial`, 0o400); await rename(`${ubuntuBase}.partial`, ubuntuBase) }
    step = 'formal-identity'
    const record = JSON.parse(await readFile(join(source, 'releases', 'acceptance', `${tag.slice(1)}.json`), 'utf8'))
    const tagged = checked('git', ['-C', source, 'rev-parse', '--verify', `${tag}^{commit}`]).trim()
    if (tagged !== record.commit) throw new Error(`Tag ${tag} points at ${tagged}, but the acceptance record declares ${record.commit}`)
    const installer = join(workDir, 'install.sh')
    await writeFile(installer, checked('git', ['-C', source, 'show', `${tag}:install.sh`]))
    step = 'boot'
    const key = join(workDir, 'id_ed25519')
    checked('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', `baseline-${tag}`, '-f', key])
    const seed = await makeSeed(workDir, instanceIdFor('prepare', tag), (await readFile(`${key}.pub`, 'utf8')).trim())
    const overlay = join(workDir, 'disk.qcow2')
    checked('qemu-img', overlayCreateArgs(ubuntuBase, overlay))
    checked('qemu-img', ['resize', overlay, `${diskGib}G`])
    const sshPort = Number(options.sshPort ?? await freePort())
    vm = { ...bootVm({ overlay, seed, workDir, sshPort, forwards: [], memoryMib }), overlay }
    await recordRunningVm(store, vm.pidFile)
    await waitForSsh(key, sshPort, workDir, 15 * 60_000)
    step = 'install'
    await sshOutput(key, sshPort, 'sudo -n tee /var/tmp/dsh-phalanx-formal-install.sh >/dev/null', await readFile(installer, 'utf8'))
    const installStarted = Date.now()
    const result = await sshOutput(key, sshPort, formalInstallCommand('/var/tmp/dsh-phalanx-formal-install.sh', tag, preset), undefined, 'any')
      .finally(() => { receipt.installSeconds = Math.round((Date.now() - installStarted) / 100) / 10 })
    await writeFile(join(workDir, 'install.stdout.json'), result.stdout); await writeFile(join(workDir, 'install.stderr.log'), result.stderr)
    receipt.exitCode = result.code
    if (result.code !== 0) throw new Error(`Formal install exited ${result.code}; see ${workDir}/install.stderr.log`)
    const identity = installIdentity(JSON.parse(result.stdout), record)
    step = 'reseal'
    // The power-off can drop the session before it closes cleanly; the VM exit below is the real check.
    await sshOutput(key, sshPort, 'bash -s', resealScript(), [0, 255])
    await waitVmExit(vm.pidFile, 10 * 60_000)
    vm = undefined
    step = 'convert'
    checked('qemu-img', ['convert', '-O', 'qcow2', overlay, `${base}.partial`])
    await chmod(`${base}.partial`, 0o400)
    await rename(`${base}.partial`, base)
    const bytes = (await stat(base)).size
    Object.assign(receipt, { exitCode: 0, ...identity, base: { path: basename(base), sha256: await sha256File(base), bytes, virtualGib: diskGib }, createdUtc: new Date().toISOString() })
    parseBaselineReceipt(receipt)
    await writeFile(`${receiptPath}.partial`, JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 })
    await rename(`${receiptPath}.partial`, receiptPath)
    await rm(workDir, { recursive: true, force: true })
    console.log(JSON.stringify({ prepared: true, tag, base, baseSha256: receipt.base.sha256, installSeconds: receipt.installSeconds, imageDigest: receipt.imageDigest, harness: receipt.harness }))
  } catch (error) {
    if (vm !== undefined) await stopVm(vm.pidFile, vm.overlay).catch(stopError => { error.message += `; the VM could not be stopped: ${stopError.message}` })
    await mkdir(workDir, { recursive: true, mode: 0o700 }).catch(() => {})
    await writeFile(join(workDir, 'failed-receipt.json'), JSON.stringify({ ...receipt, failedStep: step, createdUtc: new Date().toISOString(), error: String(error.message ?? error) }, null, 2) + '\n').catch(() => {})
    await rm(join(workDir, 'id_ed25519'), { force: true }).catch(() => {})
    for (const partial of [`${base}.partial`, `${receiptPath}.partial`, join(store, `ubuntu-${options.ubuntuSha256.slice(0, 12)}.qcow2.partial`)]) await rm(partial, { force: true }).catch(() => {})
    throw error
  } finally {
    // A QEMU that could not be stopped keeps its lock; a stopped one leaves a dead holder, which is released.
    releaseVm(store, [process.pid])
  }
}

async function stage(options) {
  const { store, tag, name } = options
  await privateStore(store)
  const receipt = await verifyBase(store, tag)
  const workDir = options.workDir ?? join(store, 'stages', name)
  if (exists(join(workDir, 'disk.qcow2'))) throw new Error(`${workDir} already has a disk; end that stage first`)
  // The base reached the guest at 127.0.0.1:18080, which the installed origin check expects.
  if (options.forwards.some(forward => forward.guest === GUEST_SERVICE_PORT && forward.host !== GUEST_SERVICE_PORT))
    throw new Error(`The baseline serves origin http://127.0.0.1:${GUEST_SERVICE_PORT}; forward it as --forward ${GUEST_SERVICE_PORT}`)
  claimSingleVm(store)
  let vm
  try {
    await guardResources(store, STAGE_DISK_GIB)
    await mkdir(workDir, { recursive: true, mode: 0o700 })
    const key = join(workDir, 'id_ed25519')
    for (const file of ['id_ed25519', 'id_ed25519.pub', 'seed.img', 'user-data', 'meta-data']) await rm(join(workDir, file), { force: true })
    checked('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', `stage-${name}`, '-f', key])
    const seed = await makeSeed(workDir, instanceIdFor('stage', name), (await readFile(`${key}.pub`, 'utf8')).trim())
    const overlay = join(workDir, 'disk.qcow2')
    checked('qemu-img', overlayCreateArgs(storePaths(store, tag).base, overlay))
    const sshPort = Number(options.sshPort ?? await freePort())
    vm = { ...bootVm({ overlay, seed, workDir, sshPort, forwards: options.forwards, memoryMib: 2048 }), overlay }
    await recordRunningVm(store, vm.pidFile)
    await waitForSsh(key, sshPort, workDir, 15 * 60_000)
    await sshOutput(key, sshPort, serviceReadyCommand()).catch(error => { throw new Error(`The installed service did not serve /login within 10 minutes: ${error.message}`) })
    const service = options.forwards.find(forward => forward.guest === GUEST_SERVICE_PORT)
    console.log(JSON.stringify({ stage: name, tag, workDir, overlay, sshPort, key, sshArgs: sshArgs(key, sshPort),
      // The guest reaches this host's fixtures through QEMU user networking.
      fixtureAddress: QEMU_HOST_ADDRESS, ...(service ? { origin: `http://127.0.0.1:${service.host}` } : {}),
      forwards: options.forwards, baseSha256: receipt.base.sha256, harness: receipt.harness ?? null }))
  } catch (error) {
    if (vm !== undefined) await stopVm(vm.pidFile, vm.overlay).catch(stopError => { error.message += `; the VM could not be stopped: ${stopError.message}` })
    releaseVm(store, [process.pid])
    throw new Error(`${error.message ?? error}; run end --name ${name} before reusing this stage`)
  }
}

async function end(options) {
  const { store, name } = options
  const workDir = options.workDir ?? join(store, 'stages', name)
  const pidFile = join(workDir, 'qemu.pid'), overlay = join(workDir, 'disk.qcow2')
  if (options.keepDisk && !exists(overlay)) throw new Error(`${overlay} does not exist; nothing to keep, and no other failed disk was touched`)
  const pid = await vmPid(pidFile)
  await stopVm(pidFile, overlay)
  for (const file of ['id_ed25519', 'id_ed25519.pub', 'seed.img', 'user-data', 'meta-data', 'qemu.pid']) await rm(join(workDir, file), { force: true })
  const removedFailedDisks = options.keepDisk ? await keepOnlyLatestFailedDisk(store, overlay) : []
  if (!options.keepDisk) await rm(overlay, { force: true })
  releaseVm(store, pid === undefined ? [] : [pid])
  console.log(JSON.stringify({ ended: name, workDir, disk: options.keepDisk ? 'kept as the only failed stage disk' : 'removed', removedFailedDisks }))
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  // Disks, logs and keys stay private to the validation user; the base carries instance secrets.
  process.umask(0o077)
  try {
    const { command, options } = parseCli(process.argv.slice(2))
    if (command === 'prepare') await prepare(options)
    if (command === 'stage') await stage(options)
    if (command === 'end') await end(options)
    if (command === 'verify') {
      const receipt = await verifyBase(options.store, options.tag)
      console.log(JSON.stringify({ tag: options.tag, ok: true, base: receipt.base, commit: receipt.commit, imageDigest: receipt.imageDigest, installSeconds: receipt.installSeconds, harness: receipt.harness ?? null }))
    }
  } catch (error) {
    console.error(String(error.message ?? error))
    process.exit(1)
  }
}
