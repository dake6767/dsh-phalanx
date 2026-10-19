import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'
import {
  ISO_TOOLS, MEMORY_FLOOR_MIB, PREPARE_DISK_GIB, STAGE_DISK_GIB, availableDiskGib, availableMemoryMib,
  cloudInitSeed, formalInstallCommand, installIdentity, overlayCreateArgs, parseBaselineReceipt, parseCli,
  bootVm, claimSingleVm, instanceIdFor, makeSeed, memoryFloorMib, ownsVm, qemuArgs, releaseVm, resolveIsoTool, resealCommands, resealScript, seedCommand,
  serviceReadyCommand, sshArgs, verifyBaseline, waitVmExit,
} from '../scripts/validation/t4-baseline.mjs'

// The formal 0.1.19 acceptance identity, as the snapshot receipt records it.
const formal = {
  schema: 1,
  tag: 'v0.1.19',
  commit: '5b45ebc2a3eeeffcb29572eb0d627a5c42d1d07d',
  ubuntu: { image: 'noble-server-cloudimg-amd64.img', sha256: '04e8f2461a16a44e78a370284471f29616cdd9baf1893df25807b71f985b6c94' },
  platformSha256: '2bdc1d6a9c7190d7f8961e808b4274330dfbfa363acff6e2c9e00d4b44261bb5',
  imageDigest: 'sha256:ce4e7f16cb89bdc3a52fd54534da50a8c223d31f62d46fe6ed3650b295b70bda',
  installSeconds: 2263.2,
  exitCode: 0,
  base: { path: 'formal-v0.1.19.qcow2', sha256: 'a'.repeat(64), bytes: 9_000_000_000, virtualGib: 32 },
  createdUtc: '2026-10-19T12:00:00.000Z',
}
const record = { commit: formal.commit, platformSha256: formal.platformSha256, imageDigest: formal.imageDigest }
const report = { status: 'installed', changed: true, ...record }

it('parses a successful formal receipt and keeps failures structural-only', () => {
  expect(parseBaselineReceipt(formal)).toEqual(formal)
  expect(parseBaselineReceipt({ schema: 1, tag: 'v0.1.19', commit: formal.commit, ubuntu: formal.ubuntu, installSeconds: 4.2, exitCode: 1 })).toMatchObject({ exitCode: 1 })
  // A failure before the install ran records no exit code rather than a fabricated one.
  expect(parseBaselineReceipt({ schema: 1, tag: 'v0.1.19', commit: formal.commit, ubuntu: formal.ubuntu, installSeconds: 0, exitCode: null })).toMatchObject({ exitCode: null })
  expect(parseBaselineReceipt({ ...formal, preset: 'mainland', harness: { commit: formal.commit, scriptSha256: 'b'.repeat(64) } })).toMatchObject({ preset: 'mainland' })
  for (const [broken, field] of [
    [{ ...formal, tag: '0.1.19' }, 'tag'],
    [{ ...formal, schema: 2 }, 'schema'],
    [{ ...formal, commit: '5b45ebc' }, 'commit'],
    [{ ...formal, ubuntu: { image: 'x.img', sha256: '04e8' } }, 'ubuntu'],
    [{ ...formal, installSeconds: 0 }, 'installSeconds'],
    [{ ...formal, exitCode: 0.5 }, 'exitCode'],
    [{ ...formal, base: { ...formal.base, path: 'nested/formal.qcow2' } }, 'base'],
    [{ ...formal, imageDigest: 'ce4e7f16' }, 'imageDigest'],
    [{ ...formal, preset: 'nearby' }, 'preset'],
    [{ ...formal, harness: { commit: 'HEAD', scriptSha256: 'b'.repeat(64) } }, 'harness'],
  ] as [Record<string, unknown>, string][]) expect(() => parseBaselineReceipt(broken), field).toThrow()
})

it('boots the base only when the receipt is a success whose hash still matches', () => {
  expect(verifyBaseline(formal, formal.base.sha256)).toMatchObject({ ok: true, reinstall: false })
  expect(verifyBaseline(formal, 'b'.repeat(64))).toMatchObject({ ok: false, reinstall: true, expected: formal.base.sha256, actual: 'b'.repeat(64) })
  expect(verifyBaseline({ ...formal, exitCode: 1 }, formal.base.sha256)).toMatchObject({ ok: false, reinstall: true })
})

it('injects only a public key through the NoCloud seed', () => {
  const seed = cloudInitSeed({ instanceId: 'stage-offline-1f2', publicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEh4cmZlaGFs example@baseline' })
  expect(seed['user-data'].startsWith('#cloud-config\n')).toBe(true)
  expect(seed['user-data']).toContain('ssh_pwauth: false\n')
  expect(seed['user-data']).toContain('name: validator\n    sudo: ALL=(ALL) NOPASSWD:ALL')
  expect(seed['user-data']).toContain('ssh_authorized_keys:\n      - ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEh4cmZlaGFs example@baseline')
  expect(seed['meta-data']).toContain('instance-id: stage-offline-1f2\n')
  expect(`${seed['user-data']}${seed['meta-data']}`).not.toContain('PRIVATE KEY')
  expect(() => cloudInitSeed({ instanceId: 'bad id!', publicKey: 'ssh-ed25519 AAAA x' })).toThrow()
  expect(() => cloudInitSeed({ instanceId: 'ok-id', publicKey: 'ssh-ed25519 AAAA x\nssh-ed25519 BBBB y' })).toThrow()
})

it('derives valid instance ids from dotted formal tags and long stage names', () => {
  // A formal tag's dots and a 64-character stage name are both rejected by the raw seed rule.
  expect(instanceIdFor('prepare', 'v0.1.19', 'a1b2c3d4')).toBe('prepare-0-1-19-a1b2c3d4')
  const long = instanceIdFor('stage', 'x'.repeat(64))
  expect(long.length).toBe(64)
  expect(() => cloudInitSeed({ instanceId: long, publicKey: 'ssh-ed25519 AAAA example' })).not.toThrow()
  expect(instanceIdFor('stage', 'offline')).not.toBe(instanceIdFor('stage', 'offline'))
})

it('builds the seed with whichever NoCloud tool the host provides', () => {
  expect(ISO_TOOLS[0]).toBe('cloud-localds')
  expect(resolveIsoTool(['mkisofs', 'xorriso'])).toBe('mkisofs')
  expect(resolveIsoTool(['docker'])).toBeUndefined()
  expect(seedCommand('cloud-localds', '/w/seed.img')).toEqual(['cloud-localds', '/w/seed.img', 'user-data', 'meta-data'])
  expect(seedCommand('genisoimage', '/w/seed.img')).toEqual(['genisoimage', '-output', '/w/seed.img', '-volid', 'cidata', '-joliet', '-rock', 'user-data', 'meta-data'])
  expect(seedCommand('xorriso', '/w/seed.img')).toEqual(['xorriso', '-as', 'mkisofs', '-output', '/w/seed.img', '-volid', 'cidata', '-joliet', '-rock', 'user-data', 'meta-data'])
  expect(() => seedCommand('brew', '/w/seed.img')).toThrow(/NoCloud seed tool/)
})

it('gives every stage its own overlay of the read-only base', () => {
  expect(overlayCreateArgs('/store/formal-v0.1.19.qcow2', '/work/disk.qcow2'))
    .toEqual(['create', '-f', 'qcow2', '-b', '/store/formal-v0.1.19.qcow2', '-F', 'qcow2', '/work/disk.qcow2'])
})

it('boots exactly one software-emulated VM bound to loopback only', () => {
  const args = qemuArgs({ overlay: '/w/disk.qcow2', seed: '/w/seed.img', sshPort: 2222, forwards: [{ guest: 18080, host: 18080 }], pidFile: '/w/qemu.pid', serialLog: '/w/serial.log' })
  expect(args).toContain('-accel')
  expect(args[args.indexOf('-accel') + 1]).toBe('tcg')
  expect(args.filter(argument => argument.startsWith('file=')))
    .toEqual(['file=/w/disk.qcow2,format=qcow2,if=virtio', 'file=/w/seed.img,format=raw,if=virtio,readonly=on'])
  expect(args.filter(argument => argument.startsWith('user,id=net0,')).join(' '))
    .toBe('user,id=net0,hostfwd=tcp:127.0.0.1:2222-:22,hostfwd=tcp:127.0.0.1:18080-:18080')
  expect(args).toContain('-daemonize')
  expect(args[args.indexOf('-m') + 1]).toBe('2048')
  expect(args[args.indexOf('-smp') + 1]).toBe('2')
})

it('runs the formal installer unchanged with the mainland preset', () => {
  const command = formalInstallCommand('/var/tmp/dsh-phalanx-formal-install.sh', 'v0.1.19')
  expect(command).toContain('sudo -n bash /var/tmp/dsh-phalanx-formal-install.sh --version v0.1.19')
  expect(command).toContain('--download-source-preset mainland')
  expect(command).toContain('--listen-address 0.0.0.0 --port 18080 --public-origin http://127.0.0.1:18080')
  expect(command).toContain('--output json')
  expect(formalInstallCommand('/i', 'v0.1.19', 'official')).toContain('--download-source-preset official')
  // Every interpolated value reaches a remote shell, so each is constrained.
  expect(() => formalInstallCommand('/i', 'v0.1.19', 'mainland; reboot')).toThrow(/known preset/)
  expect(() => formalInstallCommand('/i x', 'v0.1.19')).toThrow(/absolute installer/)
  expect(() => formalInstallCommand('/i', 'v0.1.19 --yes')).toThrow(/vX.Y.Z tag/)
})

it('accepts the installer report only when it matches the formal acceptance record', () => {
  expect(installIdentity(report, record)).toEqual(record)
  expect(() => installIdentity({ ...report, status: 'upgrade' }, record)).toThrow(/status upgrade/)
  expect(() => installIdentity({ ...report, changed: false }, record)).toThrow(/not pristine/)
  expect(() => installIdentity({ ...report, imageDigest: 'sha256:' + 'c'.repeat(64) }, record)).toThrow(/imageDigest/)
})

it('reseals the base so no install-time login survives', () => {
  const commands = resealCommands().join('\n')
  expect(commands).toContain('rm -f /home/validator/.ssh/authorized_keys /root/.ssh/authorized_keys')
  expect(commands).toContain('find /var/lib/cloud -type f -name authorized_keys -delete')
  expect(commands).toContain('cloud-init clean --logs --machine-id')
  expect(commands).not.toContain('PRIVATE KEY')
  // One session: the login key goes last, and power-off is detached so the session can return cleanly.
  const script = resealScript().split('\n').filter(Boolean)
  expect(script[0]).toBe('set -eu')
  expect(script.findIndex(line => line.includes('authorized_keys /root'))).toBeGreaterThan(script.findIndex(line => line.includes('cloud-init clean')))
  expect(script.at(-1)).toBe('(sleep 2; sudo -n systemctl poweroff) >/dev/null 2>&1 &')
})

it('reports a stage only after the installed entry serves its login page', () => {
  // SSH answers before the user service; a stage handed over earlier fails its first request.
  const command = serviceReadyCommand(600)
  expect(command).toContain('http://127.0.0.1:18080/login')
  expect(command).toContain('--max-time 10')
  // Run it against stubbed curl and sleep to check its remote-shell quoting and exit status.
  const ready = (code: string) => spawnSync('bash', ['-c', `curl() { printf %s ${code}; }; sleep() { :; }; ${serviceReadyCommand(15)}`]).status
  expect(ready('200')).toBe(0)
  expect(ready('000')).toBe(1)
})

it('reads host memory and disk headroom conservatively', () => {
  expect(availableMemoryMib('MemTotal:       8161940 kB\nMemFree:         1000384 kB\nMemAvailable:   6758520 kB\n')).toBeCloseTo(6600.12, 2)
  expect(availableDiskGib({ bsize: 4096, bavail: 2621440 })).toBe(10)
  expect(() => availableMemoryMib('MemTotal: 8161940 kB\n')).toThrow(/MemAvailable/)
  // The default 2 GiB guest keeps the measured floor; a larger guest raises it with its emulation overhead.
  expect(memoryFloorMib(2048)).toBe(MEMORY_FLOOR_MIB)
  expect(memoryFloorMib(8192)).toBe(14108)
  expect(MEMORY_FLOOR_MIB).toBeGreaterThanOrEqual(3200 + 1000)
  expect(PREPARE_DISK_GIB).toBeGreaterThan(STAGE_DISK_GIB)
})

it('parses the command line for every subcommand', () => {
  const { command, options } = parseCli(['prepare', '--store', '/s', '--ubuntu-image', '/u.img', '--ubuntu-sha256', formal.ubuntu.sha256, '--tag', 'v0.1.19', '--source', '/src'])
  expect(command).toBe('prepare')
  expect(options).toMatchObject({ store: '/s', ubuntuImage: '/u.img', ubuntuSha256: formal.ubuntu.sha256, tag: 'v0.1.19', source: '/src' })
  expect(parseCli(['stage', '--store', '/s', '--tag', 'v0.1.19', '--name', 'offline-upgrade', '--forward', '18080', '--forward', '18081:19081']).options.forwards)
    .toEqual([{ guest: 18080, host: 18080 }, { guest: 18081, host: 19081 }])
  expect(parseCli(['end', '--store', '/s', '--name', 'offline-upgrade', '--keep-disk']).options).toMatchObject({ keepDisk: true })
  expect(parseCli(['verify', '--store', '/s', '--tag', 'v0.1.19']).options.tag).toBe('v0.1.19')
  expect(() => parseCli(['stage', '--store', '/s', '--tag', 'v0.1.19'])).toThrow(/requires --name/)
  expect(() => parseCli(['stage', '--store', '/s', '--tag', 'v0.1.19', '--name', 'x', '--forward', '22'])).toThrow(/SSH port reserved/)
  expect(() => parseCli(['prepare', '--store', '/s', '--speed', '9'])).toThrow(/Unknown option/)
  expect(() => parseCli(['prepare', '--store', '/s', '--tag'])).toThrow(/needs a value/)
  expect(parseCli(['prepare', '--store', 'rel', '--ubuntu-image', 'u.img', '--ubuntu-sha256', formal.ubuntu.sha256, '--tag', 'v0.1.19', '--source', 'src', '--replace-corrupt']).options)
    .toMatchObject({ store: resolve('rel'), ubuntuImage: resolve('u.img'), source: resolve('src'), replaceCorrupt: true })
  for (const argv of [
    ['end', '--store', '/s', '--name', '../../x'], ['verify', '--store', '/s', '--tag', 'latest'],
    ['stage', '--store', '/s', '--tag', 'v0.1.19', '--name', 'x', '--forward', '18080:22'],
    ['stage', '--store', '/s', '--tag', 'v0.1.19', '--name', 'x', '--forward', '70000'], ['verify', '--store', '/s,x', '--tag', 'v0.1.19'],
    ['stage', '--store', '/s', '--tag', 'v0.1.19', '--name', 'x', '--ssh-port', '18080', '--forward', '18080'],
    ['prepare', '--store', '/s', '--ubuntu-image', '/u', '--ubuntu-sha256', formal.ubuntu.sha256, '--tag', 'v0.1.19', '--source', '/r', '--disk-gib', 'NaN'],
    ['prepare', '--store', '/s', '--ubuntu-image', '/u', '--ubuntu-sha256', formal.ubuntu.sha256, '--tag', 'v0.1.19', '--source', '/r', '--harness-commit', 'HEAD'],
    ['prepare', '--store', '/s', '--ubuntu-image', '/u', '--ubuntu-sha256', '/../../../aa', '--tag', 'v0.1.19', '--source', '/r'],
  ]) expect(() => parseCli(argv), argv.join(' ')).toThrow()
})

it('prints usage and fails without a subcommand', () => {
  const result = spawnSync(process.execPath, [resolve('scripts/validation/t4-baseline.mjs')], { encoding: 'utf8' })
  expect(result.status).toBe(1)
  expect(result.stderr).toContain('Usage: t4-baseline.mjs')
})

it('treats a removed QEMU pid file as a stopped VM and rejects a corrupt one', async () => {
  const root = await mkdtemp(join(tmpdir(), 't4-baseline-'))
  try {
    // QEMU deletes its pid file on exit; that must not read as pid 0, which signals this process group.
    await expect(waitVmExit(join(root, 'qemu.pid'), 200, 10)).resolves.toBeUndefined()
    await writeFile(join(root, 'stale.pid'), '2147483646\n')
    await expect(waitVmExit(join(root, 'stale.pid'), 200, 10)).resolves.toBeUndefined()
    await writeFile(join(root, 'self.pid'), `${process.pid}\n`)
    await expect(waitVmExit(join(root, 'self.pid'), 50, 10)).rejects.toThrow('did not stop')
    await writeFile(join(root, 'corrupt.pid'), 'not-a-pid\n')
    await expect(waitVmExit(join(root, 'corrupt.pid'), 50, 10)).rejects.toThrow('Invalid pid')
    await writeFile(join(root, 'empty.pid'), '\n')
    await expect(waitVmExit(join(root, 'empty.pid'), 50, 10)).rejects.toThrow('Invalid pid')
  } finally { await rm(root, { recursive: true, force: true }) }
})

// The pure builders above return argv with the tool first; the executors must run that tool with the rest.
it('runs the seed tool and QEMU with exactly the argv their builders return', async () => {
  const root = await mkdtemp(join(tmpdir(), 't4-baseline-exec-'))
  const path = process.env.PATH
  try {
    for (const tool of ['cloud-localds', 'qemu-system-x86_64']) {
      await writeFile(join(root, tool), `#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(join(root, tool + '.argv'))}\n`)
      await chmod(join(root, tool), 0o755)
    }
    process.env.PATH = `${root}:${path}`
    const seed = await makeSeed(root, 'prepare-0-1-19-a1b2c3d4', 'ssh-ed25519 AAAA example')
    expect((await readFile(join(root, 'cloud-localds.argv'), 'utf8')).split('\n').filter(Boolean)).toEqual(seedCommand('cloud-localds', seed).slice(1))
    const options = { overlay: join(root, 'disk.qcow2'), seed, workDir: root, sshPort: 22219, forwards: [], memoryMib: 2048 }
    const { pidFile, serialLog } = bootVm(options)
    expect((await readFile(join(root, 'qemu-system-x86_64.argv'), 'utf8')).split('\n').filter(Boolean)).toEqual(qemuArgs({ ...options, pidFile, serialLog }).slice(1))
  } finally { process.env.PATH = path; await rm(root, { recursive: true, force: true }) }
})

it('claims the single-VM lock atomically and releases only its own or a dead holder', async () => {
  const root = await mkdtemp(join(tmpdir(), 't4-baseline-lock-'))
  try {
    claimSingleVm(root)
    expect((await readFile(join(root, 'vm.lock'), 'utf8')).trim()).toBe(String(process.pid))
    expect(((await stat(join(root, 'vm.lock'))).mode & 0o777)).toBe(0o600)
    // A second claim while the holder lives must fail, before any slow work.
    expect(() => claimSingleVm(root)).toThrow(/Another baseline VM is running/)
    // Ending some other stage must not release the running holder's lock.
    releaseVm(root, [123456789])
    expect((await readFile(join(root, 'vm.lock'), 'utf8')).trim()).toBe(String(process.pid))
    releaseVm(root, [process.pid])
    await expect(readFile(join(root, 'vm.lock'))).rejects.toThrow()
    // A dead holder is reclaimed; a corrupt lock is an error, never a free lock.
    await writeFile(join(root, 'vm.lock'), '2147483646\n')
    claimSingleVm(root)
    expect((await readFile(join(root, 'vm.lock'), 'utf8')).trim()).toBe(String(process.pid))
    await writeFile(join(root, 'vm.lock'), 'garbage\n')
    expect(() => claimSingleVm(root)).toThrow(/Invalid pid/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('signals only the QEMU that runs this stage disk', () => {
  const qemu = ['qemu-system-x86_64', '-accel', 'tcg', '-drive', 'file=/s/stages/a/disk.qcow2,format=qcow2,if=virtio', ''].join('\0')
  expect(ownsVm(qemu, '/s/stages/a/disk.qcow2')).toBe(true)
  expect(ownsVm(qemu, '/s/stages/b/disk.qcow2')).toBe(false)
  expect(ownsVm(['bash', '-c', 'file=/s/stages/a/disk.qcow2,', ''].join('\0'), '/s/stages/a/disk.qcow2')).toBe(false)
})

it('hands stages ready-made SSH arguments with keepalives', () => {
  expect(sshArgs('/k', 2222)).toEqual(['-i', '/k', '-p', '2222', '-o', 'IdentitiesOnly=yes', '-o', 'UserKnownHostsFile=/dev/null', '-o', 'StrictHostKeyChecking=no',
    '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', '-o', 'ServerAliveInterval=30', '-o', 'ServerAliveCountMax=6', 'validator@127.0.0.1'])
})

// The command-level guards run before any VM work, so they are exercised without QEMU.
it('refuses a shared store, a misforwarded origin and a non-corrupt replacement', async () => {
  const root = await mkdtemp(join(tmpdir(), 't4-baseline-cli-'))
  const cli = (...args: string[]) => spawnSync(process.execPath, [resolve('scripts/validation/t4-baseline.mjs'), ...args], { encoding: 'utf8' })
  try {
    const shared = join(root, 'shared')
    await mkdir(shared, { mode: 0o755 }); await chmod(shared, 0o755)
    expect(cli('verify', '--store', shared, '--tag', 'v0.1.19').stderr).toContain('No baseline receipt')
    expect(cli('stage', '--store', shared, '--tag', 'v0.1.19', '--name', 'x').stderr).toContain('mode 700')
    const store = join(root, 'store')
    await mkdir(store, { mode: 0o700 })
    expect(cli('stage', '--store', store, '--tag', 'v0.1.19', '--name', 'x').stderr).toContain('No baseline receipt')
    await writeFile(join(store, 'formal-v0.1.19.qcow2'), 'base')
    await writeFile(join(store, 'formal-v0.1.19.receipt.json'), JSON.stringify({ ...formal, base: { ...formal.base, sha256: createHash('sha256').update('base').digest('hex') } }))
    expect(cli('stage', '--store', store, '--tag', 'v0.1.19', '--name', 'x', '--forward', '18080:19080').stderr).toContain('--forward 18080')
    const prepare = (...extra: string[]) => cli('prepare', '--store', store, '--ubuntu-image', join(root, 'u.img'), '--ubuntu-sha256', formal.ubuntu.sha256, '--tag', 'v0.1.19', '--source', root, ...extra).stderr
    expect(prepare()).toContain('already exists')
    expect(prepare('--replace-corrupt')).toContain('--replace-corrupt only reinstalls a base that fails verification')
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('keeps only the most recent failed stage disk', async () => {
  const store = await mkdtemp(join(tmpdir(), 't4-baseline-failed-'))
  const cli = (...args: string[]) => spawnSync(process.execPath, [resolve('scripts/validation/t4-baseline.mjs'), ...args], { encoding: 'utf8' })
  try {
    await chmod(store, 0o700)
    for (const name of ['first', 'second']) {
      await mkdir(join(store, 'stages', name), { recursive: true })
      await writeFile(join(store, 'stages', name, 'disk.qcow2'), name)
    }
    const kept = JSON.parse(cli('end', '--store', store, '--name', 'second', '--keep-disk').stdout) as { removedFailedDisks: string[] }
    expect(kept.removedFailedDisks).toEqual([join(store, 'stages', 'first', 'disk.qcow2')])
    expect(await readFile(join(store, 'stages', 'second', 'disk.qcow2'), 'utf8')).toBe('second')
    await expect(readFile(join(store, 'stages', 'first', 'disk.qcow2'))).rejects.toThrow()
    // A mistyped name keeps nothing and removes nothing.
    expect(cli('end', '--store', store, '--name', 'third', '--keep-disk').stderr).toContain('nothing to keep')
    expect(await readFile(join(store, 'stages', 'second', 'disk.qcow2'), 'utf8')).toBe('second')
    expect(JSON.parse(cli('end', '--store', store, '--name', 'second').stdout)).toMatchObject({ disk: 'removed' })
  } finally { await rm(store, { recursive: true, force: true }) }
})
