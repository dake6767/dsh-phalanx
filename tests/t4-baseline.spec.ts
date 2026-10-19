import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { expect, it } from 'vitest'
import {
  ISO_TOOLS, MEMORY_FLOOR_MIB, PREPARE_DISK_GIB, STAGE_DISK_GIB, availableDiskGib, availableMemoryMib,
  cloudInitSeed, formalInstallCommand, installIdentity, overlayCreateArgs, parseBaselineReceipt, parseCli,
  qemuArgs, resolveIsoTool, resealCommands, seedCommand, verifyBaseline,
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
  for (const [broken, field] of [
    [{ ...formal, tag: '0.1.19' }, 'tag'],
    [{ ...formal, schema: 2 }, 'schema'],
    [{ ...formal, commit: '5b45ebc' }, 'commit'],
    [{ ...formal, ubuntu: { image: 'x.img', sha256: '04e8' } }, 'ubuntu'],
    [{ ...formal, installSeconds: 0 }, 'installSeconds'],
    [{ ...formal, exitCode: 0.5 }, 'exitCode'],
    [{ ...formal, base: { ...formal.base, path: 'nested/formal.qcow2' } }, 'base'],
    [{ ...formal, imageDigest: 'ce4e7f16' }, 'imageDigest'],
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
  expect(commands).toContain('cloud-init clean --logs')
  expect(commands).not.toContain('PRIVATE KEY')
})

it('reads host memory and disk headroom conservatively', () => {
  expect(availableMemoryMib('MemTotal:       8161940 kB\nMemFree:         1000384 kB\nMemAvailable:   6758520 kB\n')).toBeCloseTo(6600.12, 2)
  expect(availableDiskGib({ bsize: 4096, bavail: 2621440 })).toBe(10)
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
})

it('prints usage and fails without a subcommand', () => {
  const result = spawnSync(process.execPath, [resolve('scripts/validation/t4-baseline.mjs')], { encoding: 'utf8' })
  expect(result.status).toBe(1)
  expect(result.stderr).toContain('Usage: t4-baseline.mjs')
})
