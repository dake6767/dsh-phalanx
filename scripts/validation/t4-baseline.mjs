// Formal baseline snapshots for T4 stages: install the formal previous release
// once on a pristine Ubuntu cloud image, keep the result as a read-only qcow2
// base with a creation receipt, and boot every stage from its own overlay with
// a one-time injected SSH identity. The snapshot never contains credentials.
import { spawn, spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { chmod, copyFile, mkdir, readFile, rm, stat, statfs, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'

export const VALIDATOR_USER = 'validator'
export const GUEST_SERVICE_PORT = 18080
// A 2 GiB guest under software emulation measured about 3.2 GiB resident; keep
// the host floor above that plus headroom, and never run a second VM.
export const MEMORY_FLOOR_MIB = 5000
export const PREPARE_DISK_GIB = 20
export const STAGE_DISK_GIB = 10
export const ISO_TOOLS = ['cloud-localds', 'genisoimage', 'mkisofs', 'xorriso']

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
  if (typeof receipt.installSeconds !== 'number' || !(receipt.installSeconds > 0)) throw new Error('Receipt must record a positive install duration')
  if (!Number.isInteger(receipt.exitCode)) throw new Error('Receipt must record an integer install exit code')
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
    `sudo -n rm -f /home/${user}/.ssh/authorized_keys /root/.ssh/authorized_keys`,
    'sudo -n find /var/lib/cloud -type f -name authorized_keys -delete',
    'sudo -n cloud-init clean --logs',
    'sudo -n sync',
  ]
}

export function availableMemoryMib(meminfo) {
  return Number(/^MemAvailable:\s+(\d+) kB$/mu.exec(meminfo)?.[1]) / 1024
}

export function availableDiskGib({ bsize, bavail }) {
  return bsize * bavail / 2 ** 30
}

export function storePaths(store, tag) {
  return { base: join(store, `formal-${tag}.qcow2`), receipt: join(store, `formal-${tag}.receipt.json`) }
}

const CLI_SPEC = {
  prepare: { required: ['store', 'ubuntu-image', 'ubuntu-sha256', 'tag', 'source'], optional: ['disk-gib', 'memory-mib', 'ssh-port', 'preset'] },
  stage: { required: ['store', 'tag', 'name'], optional: ['ssh-port', 'work-dir', 'forward'] },
  end: { required: ['store', 'name'], optional: ['work-dir', 'keep-disk'] },
  verify: { required: ['store', 'tag'], optional: [] },
}
const CLI_NAMES = { 'ubuntu-image': 'ubuntuImage', 'ubuntu-sha256': 'ubuntuSha256', 'ssh-port': 'sshPort', 'disk-gib': 'diskGib', 'memory-mib': 'memoryMib', 'work-dir': 'workDir', 'keep-disk': 'keepDisk' }

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
    if (name === 'keep-disk') { options.keepDisk = true; continue }
    const value = rest[index += 1]
    if (value === undefined) throw new Error(`--${name} needs a value`)
    if (name === 'forward') forwards.push(value)
    else options[CLI_NAMES[name] ?? name] = value
  }
  const missing = spec.required.filter(name => options[CLI_NAMES[name] ?? name] === undefined)
  if (missing.length) throw new Error(`${command} requires --${missing.join(' --')}`)
  options.forwards = forwards.map(entry => {
    const [guest, host = guest] = entry.split(':')
    if (!/^\d+$/u.test(guest) || !/^\d+$/u.test(host) || Number(guest) === 22) throw new Error(`--forward needs GUEST_PORT[:HOST_PORT] with the SSH port reserved, not ${entry}`)
    return { guest: Number(guest), host: Number(host) }
  })
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
const exists = path => run('test', ['-e', path]).status === 0

async function sha256File(path) {
  const { createReadStream } = await import('node:fs')
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

function sshArgs(key, port) {
  return ['-i', key, '-p', String(port), '-o', 'IdentitiesOnly=yes', '-o', 'UserKnownHostsFile=/dev/null', '-o', 'StrictHostKeyChecking=no',
    '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', `${VALIDATOR_USER}@127.0.0.1`]
}

function sshOutput(key, port, command, input, acceptedExit = [0]) {
  return new Promise((resolve, reject) => {
    const child = spawn('ssh', [...sshArgs(key, port), command], { stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    child.stdout.on('data', data => { stdout += String(data) }); child.stderr.on('data', data => { stderr += String(data) })
    child.stdin.on('error', () => {})
    child.once('error', reject)
    child.once('close', code => {
      if (acceptedExit.includes(code)) resolve({ code, stdout, stderr })
      else reject(new Error(`ssh ${command} failed (${code}): ${stderr}`))
    })
    child.stdin.end(input)
  })
}

async function freePort() {
  const { createServer } = await import('node:net')
  return await new Promise((resolvePort, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolvePort(port)) })
  })
}

const lockPath = store => join(store, 'vm.lock')

/** One software-emulated VM at a time: a second QEMU has exhausted the host before. */
function claimSingleVm(store) {
  if (!exists(lockPath(store))) return
  const holder = Number(readFileSync(lockPath(store), 'utf8').trim())
  try { process.kill(holder, 0) } catch { return }
  throw new Error(`Another baseline VM is running (pid ${holder}); software emulation allows only one`)
}

async function recordRunningVm(store, pidFile) {
  await writeFile(lockPath(store), `${(await readFile(pidFile, 'utf8')).trim()}\n`)
}

async function guardResources(store, diskFloorGib) {
  const memory = availableMemoryMib(readFileSync('/proc/meminfo', 'utf8'))
  if (memory < MEMORY_FLOOR_MIB) throw new Error(`Only ${Math.round(memory)} MiB available; a software-emulated VM needs ${MEMORY_FLOOR_MIB} MiB`)
  const free = availableDiskGib(await statfs(store))
  if (free < diskFloorGib) throw new Error(`Only ${free.toFixed(1)} GiB free in the store; this command reserves ${diskFloorGib} GiB`)
}

function bootVm({ overlay, seed, workDir, sshPort, forwards, memoryMib }) {
  const pidFile = join(workDir, 'qemu.pid'), serialLog = join(workDir, 'serial.log')
  checked('qemu-system-x86_64', qemuArgs({ overlay, seed, sshPort, memoryMib, forwards, pidFile, serialLog }))
  return { pidFile, serialLog }
}

async function waitVmExit(pidFile, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    let pid = 0
    try { pid = Number((await readFile(pidFile, 'utf8')).trim()) } catch (error) { if (error.code !== 'ENOENT') throw error }
    try { process.kill(pid, 0) } catch { return }
    await sleep(5000)
  }
  throw new Error(`VM did not stop within ${timeoutMs / 60000} minutes (${pidFile})`)
}

async function stopVm(pidFile) {
  try { process.kill(Number((await readFile(pidFile, 'utf8')).trim()), 'SIGTERM') } catch { return }
  await waitVmExit(pidFile, 2 * 60_000)
}

async function waitForSsh(key, port, workDir, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (run('ssh', [...sshArgs(key, port), 'true']).status === 0) return
    await sleep(5000)
  }
  throw new Error(`VM SSH did not come up within ${timeoutMs / 60000} minutes; see ${join(workDir, 'serial.log')}`)
}

async function readReceipt(store, tag) {
  return parseBaselineReceipt(JSON.parse(await readFile(storePaths(store, tag).receipt, 'utf8')))
}

async function verifyBase(store, tag) {
  const receipt = await readReceipt(store, tag)
  const { base } = storePaths(store, tag)
  const verdict = verifyBaseline(receipt, await sha256File(base))
  if (!verdict.ok) throw new Error(`Baseline integrity failed for ${tag}: receipt ${verdict.expected ?? '(none)'}, file ${verdict.actual}; re-run prepare to reinstall the baseline`)
  return receipt
}

async function makeSeed(workDir, instanceId, publicKey) {
  const seed = join(workDir, 'seed.img')
  const files = cloudInitSeed({ instanceId, publicKey })
  for (const name of ['user-data', 'meta-data']) await writeFile(join(workDir, name), files[name])
  const tool = resolveIsoTool(ISO_TOOLS.filter(candidate => run('sh', ['-c', `command -v ${candidate}`]).status === 0))
  if (tool === undefined) throw new Error(`The validation host needs one of: ${ISO_TOOLS.join(', ')}`)
  checked(tool, seedCommand(tool, seed), { cwd: workDir })
  return seed
}

async function prepare(options) {
  const { store, tag, source } = options
  if (!TAG.test(tag)) throw new Error(`--tag needs a formal vX.Y.Z, not ${tag}`)
  const diskGib = Number(options.diskGib ?? 32), memoryMib = Number(options.memoryMib ?? 2048)
  const { base, receipt: receiptPath } = storePaths(store, tag)
  if (exists(base)) throw new Error(`${base} already exists; verify or remove it explicitly before re-preparing`)
  await mkdir(store, { recursive: true })
  await guardResources(store, PREPARE_DISK_GIB)
  const workDir = join(store, 'prepare')
  if (exists(join(workDir, 'disk.qcow2')))
    throw new Error('A previous prepare left its disk behind; diagnose and remove it (keep only the most recent failed disk) before preparing again')
  claimSingleVm(store)
  let vm
  const receipt = { schema: 1, tag, ubuntu: { image: basename(options.ubuntuImage), sha256: options.ubuntuSha256 }, exitCode: 1, installSeconds: 0 }
  try {
    await mkdir(workDir, { recursive: true })
    const ubuntuSha = await sha256File(options.ubuntuImage)
    if (ubuntuSha !== options.ubuntuSha256) throw new Error(`Ubuntu image sha256 ${ubuntuSha} does not match the given ${options.ubuntuSha256}`)
    const ubuntuBase = join(store, `ubuntu-${options.ubuntuSha256.slice(0, 12)}.qcow2`)
    if (!exists(ubuntuBase)) { await copyFile(options.ubuntuImage, ubuntuBase); await chmod(ubuntuBase, 0o444) }
    const record = JSON.parse(await readFile(join(source, 'releases', 'acceptance', `${tag.slice(1)}.json`), 'utf8'))
    const tagged = checked('git', ['-C', source, 'rev-parse', '--verify', `${tag}^{commit}`]).trim()
    if (tagged !== record.commit) throw new Error(`Tag ${tag} points at ${tagged}, but the acceptance record declares ${record.commit}`)
    const installer = join(workDir, 'install.sh')
    await writeFile(installer, checked('git', ['-C', source, 'show', `${tag}:install.sh`]))
    const key = join(workDir, 'id_ed25519')
    checked('ssh-keygen', ['-t', 'ed25519', '-N', '', '-C', `baseline-${tag}`, '-f', key])
    const seed = await makeSeed(workDir, `prepare-${tag}`, (await readFile(`${key}.pub`, 'utf8')).trim())
    const overlay = join(workDir, 'disk.qcow2')
    checked('qemu-img', overlayCreateArgs(ubuntuBase, overlay))
    checked('qemu-img', ['resize', overlay, `${diskGib}G`])
    const sshPort = Number(options.sshPort ?? await freePort())
    vm = bootVm({ overlay, seed, workDir, sshPort, forwards: [{ guest: GUEST_SERVICE_PORT, host: GUEST_SERVICE_PORT }], memoryMib })
    await recordRunningVm(store, vm.pidFile)
    await waitForSsh(key, sshPort, workDir, 15 * 60_000)
    await sshOutput(key, sshPort, 'sudo -n tee /var/tmp/dsh-phalanx-formal-install.sh >/dev/null', await readFile(installer, 'utf8'))
    const installStarted = Date.now()
    const result = await sshOutput(key, sshPort, formalInstallCommand('/var/tmp/dsh-phalanx-formal-install.sh', tag, options.preset ?? 'mainland'), undefined, [0, 1])
      .finally(() => { receipt.installSeconds = Math.round((Date.now() - installStarted) / 100) / 10 })
    receipt.exitCode = result.code
    if (result.code !== 0) throw new Error(`Formal install exited ${result.code}`)
    const identity = installIdentity(JSON.parse(result.stdout), record)
    for (const command of resealCommands()) await sshOutput(key, sshPort, command)
    await sshOutput(key, sshPort, 'sudo -n systemctl poweroff', undefined, [0, 255])
    await waitVmExit(vm.pidFile, 10 * 60_000)
    vm = undefined
    checked('qemu-img', ['convert', '-O', 'qcow2', overlay, base])
    await chmod(base, 0o444)
    const bytes = (await stat(base)).size
    Object.assign(receipt, { exitCode: 0, ...identity, base: { path: basename(base), sha256: await sha256File(base), bytes, virtualGib: diskGib }, createdUtc: new Date().toISOString() })
    parseBaselineReceipt(receipt)
    await writeFile(receiptPath, JSON.stringify(receipt, null, 2) + '\n')
    await rm(workDir, { recursive: true, force: true })
    console.log(JSON.stringify({ prepared: true, tag, base, baseSha256: receipt.base.sha256, installSeconds: receipt.installSeconds, imageDigest: receipt.imageDigest }))
  } catch (error) {
    if (vm !== undefined) await stopVm(vm.pidFile).catch(() => {})
    await writeFile(join(workDir, 'failed-receipt.json'), JSON.stringify({ ...receipt, createdUtc: new Date().toISOString(), error: String(error.message ?? error) }, null, 2) + '\n')
    throw error
  } finally {
    run('rm', ['-f', lockPath(store)])
  }
}

async function stage(options) {
  const { store, tag, name } = options
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/u.test(name)) throw new Error(`--name must be a short lowercase slug, not ${name}`)
  await verifyBase(store, tag)
  await guardResources(store, STAGE_DISK_GIB)
  const workDir = options.workDir ?? join(store, 'stages', name)
  if (exists(join(workDir, 'disk.qcow2'))) throw new Error(`${workDir} already has a disk; end or remove that stage first`)
  claimSingleVm(store)
  let vm
  try {
    await mkdir(workDir, { recursive: true })
    const key = join(workDir, 'id_ed25519')
    checked('ssh-keygen', ['-t', 'ed25519', '-N', '', '-C', `stage-${name}`, '-f', key])
    const seed = await makeSeed(workDir, `stage-${name}-${randomUUID()}`, (await readFile(`${key}.pub`, 'utf8')).trim())
    const overlay = join(workDir, 'disk.qcow2')
    checked('qemu-img', overlayCreateArgs(storePaths(store, tag).base, overlay))
    const sshPort = Number(options.sshPort ?? await freePort())
    vm = bootVm({ overlay, seed, workDir, sshPort, forwards: options.forwards, memoryMib: 2048 })
    await recordRunningVm(store, vm.pidFile)
    await waitForSsh(key, sshPort, workDir, 15 * 60_000)
    console.log(JSON.stringify({ stage: name, tag, workDir, sshPort, key, overlay, seed, forwards: options.forwards }))
  } catch (error) {
    if (vm === undefined) run('rm', ['-f', lockPath(store)])
    else await stopVm(vm.pidFile).catch(() => {})
    throw error
  }
}

async function end(options) {
  const { store, name } = options
  const workDir = options.workDir ?? join(store, 'stages', name)
  const pidFile = join(workDir, 'qemu.pid')
  if (exists(pidFile)) await stopVm(pidFile)
  for (const file of ['id_ed25519', 'id_ed25519.pub', 'seed.img', 'user-data', 'meta-data', 'qemu.pid']) await rm(join(workDir, file), { force: true })
  if (!options.keepDisk) await rm(join(workDir, 'disk.qcow2'), { force: true })
  run('rm', ['-f', lockPath(store)])
  console.log(JSON.stringify({ ended: name, workDir, disk: options.keepDisk ? 'kept for diagnosis' : 'removed' }))
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const { command, options } = parseCli(process.argv.slice(2))
    if (command === 'prepare') await prepare(options)
    if (command === 'stage') await stage(options)
    if (command === 'end') await end(options)
    if (command === 'verify') {
      const receipt = await verifyBase(options.store, options.tag)
      console.log(JSON.stringify({ tag: options.tag, ok: true, base: receipt.base, commit: receipt.commit, imageDigest: receipt.imageDigest, installSeconds: receipt.installSeconds }))
    }
  } catch (error) {
    console.error(String(error.message ?? error))
    process.exit(1)
  }
}
