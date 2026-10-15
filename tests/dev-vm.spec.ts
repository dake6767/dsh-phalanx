import { spawnSync } from 'node:child_process'
import { mkdtemp, rm, writeFile, mkdir, access, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'
import { parse } from 'yaml'

it('confines synthetic DNS repair to owned guest entries and public answers', () => {
  const result = spawnSync('python3', ['tests/fixtures/development-dns.py'], { encoding: 'utf8' })
  expect(result.status, result.stderr).toBe(0)
})

it('explains the single Lima prerequisite before attempting VM creation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dev-vm-'))
  try {
    const result = spawnSync('/bin/bash', [resolve('scripts/dev/vm.sh'), 'up'], {
      env: { ...process.env, PATH: root }, encoding: 'utf8',
    })
    expect(result.status).not.toBe(0)
    expect(result.stderr.trim()).toBe('Lima is required: brew install lima')
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('creates one isolated VM, reuses it for upgrades, and controls only that instance', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dev-vm-'))
  try {
    const bin = join(root, 'bin'), home = join(root, 'lima'), log = join(root, 'calls.jsonl')
    await mkdir(bin)
    const commands = {
      uname: '#!/bin/bash\nif [ "$1" = -m ]; then echo arm64; else echo Darwin; fi\n',
      sysctl: '#!/bin/bash\necho 17179869184\n',
      df: '#!/bin/bash\nprintf "Filesystem 1024-blocks Used Available Capacity Mounted\\nfixture 100000000 0 52428800 0%% /\\n"\n',
      limactl: `#!/bin/bash\nexec '${process.execPath}' '${resolve('tests/fixtures/lima-cli.mjs')}' "$@"\n`,
      python3: '#!/bin/bash\nif [ "$1" = - ]; then exit "${FIXTURE_PORT_BUSY:-0}"; else exec /usr/bin/python3 "$@"; fi\n',
    }
    for (const [name, script] of Object.entries(commands)) await writeFile(join(bin, name), script, { mode: 0o755 })
    let portBusy = '1'
    const invoke = (...args: string[]) => spawnSync('/bin/bash', [resolve('scripts/dev/vm.sh'), ...args], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, DSH_PHALANX_VM_HOME: home, FIXTURE_LIMA_LOG: log, FIXTURE_PORT_BUSY: portBusy }, encoding: 'utf8',
    })
    let result = invoke('up')
    expect(result.status).not.toBe(0); expect(result.stderr).toContain('Port 18080 is already in use')
    portBusy = '0'; result = invoke('up')
    expect(result.status, result.stderr).toBe(0)
    const configuration = parse(await readFile(join(home, 'development/lima.yaml'), 'utf8'))
    expect(configuration).toMatchObject({ vmType: 'vz', arch: 'aarch64', memory: '6GiB', disk: '40GiB',
      containerd: { system: false, user: false }, mounts: [{ writable: false, mountPoint: '/mnt/dsh-phalanx' }],
      portForwards: [{ guestPort: 8080, hostIP: '127.0.0.1', hostPort: 18080 }, { ignore: true }],
    })
    result = invoke('up', '--source', 'official'); expect(result.status, result.stderr).toBe(0)
    result = invoke('down'); expect(result.status, result.stderr).toBe(0)
    expect((await readFile(log, 'utf8'))).toContain('"stop"')
    result = invoke('up'); expect(result.status, result.stderr).toBe(0)
    for (const action of ['logs', 'shell', 'test']) {
      result = invoke(action); expect(result.status, result.stderr).toBe(0)
    }
    const calls = (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as string[])
    expect(calls.filter(args => args[0] === 'create')).toHaveLength(1)
    expect(calls.some(args => args.includes('--source') && args.includes('mainland'))).toBe(true)
    expect(calls.some(args => args.includes('--source') && args.includes('official'))).toBe(true)
    expect(calls.filter(args => args[0] === 'shell').every(args => args[1] === '--workdir=/mnt/dsh-phalanx' && args[2] === 'development')).toBe(true)
    result = invoke('destroy'); expect(result.status, result.stderr).toBe(0)
    await expect(access(join(home, 'development'))).rejects.toThrow()
    await expect(access(join(home, '.dsh-phalanx-checkout'))).resolves.toBeUndefined()
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('does not stop or delete instances in an unowned Lima home', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dev-vm-'))
  try {
    const bin = join(root, 'bin'), home = join(root, 'lima'), started = join(root, 'started')
    await mkdir(bin); await mkdir(home)
    await writeFile(join(home, 'existing-user-file'), 'preserve')
    await writeFile(join(bin, 'uname'), '#!/bin/bash\nif [ "$1" = -m ]; then echo arm64; else echo Darwin; fi\n', { mode: 0o755 })
    await writeFile(join(bin, 'limactl'), '#!/bin/bash\ntouch "$FIXTURE_VM_STARTED"\n', { mode: 0o755 })
    for (const action of ['down', 'destroy']) {
      const result = spawnSync('/bin/bash', [resolve('scripts/dev/vm.sh'), action], {
        env: { ...process.env, PATH: `${bin}:/usr/bin:/bin`, DSH_PHALANX_VM_HOME: home, FIXTURE_VM_STARTED: started }, encoding: 'utf8',
      })
      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain('not owned by this checkout')
      await expect(access(started)).rejects.toThrow()
      await expect(access(join(home, 'existing-user-file'))).resolves.toBeUndefined()
    }
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('refuses an undersized Mac or disk before creating or starting a VM', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dev-vm-'))
  try {
    const bin = join(root, 'bin'); await mkdir(bin)
    const commands = {
      uname: '#!/bin/bash\nif [ "$1" = -m ]; then echo arm64; else echo Darwin; fi\n',
      sysctl: '#!/bin/bash\necho "$FIXTURE_MEMORY"\n',
      df: '#!/bin/bash\nprintf "Filesystem 1024-blocks Used Available Capacity Mounted\\nfixture 100000000 0 %s 0%% /\\n" "$FIXTURE_DISK"\n',
      limactl: '#!/bin/bash\ntouch "$FIXTURE_VM_STARTED"\n',
    }
    for (const [name, script] of Object.entries(commands)) await writeFile(join(bin, name), script, { mode: 0o755 })
    const started = join(root, 'started')
    for (const [memory, disk, message] of [
      ['8589934592', '52428800', '16 GiB of host memory'],
      ['17179869184', '20971520', '40 GiB of free disk'],
    ]) {
      const result = spawnSync('/bin/bash', [resolve('scripts/dev/vm.sh'), 'up'], {
        env: { ...process.env, PATH: `${bin}:/usr/bin:/bin`, DSH_PHALANX_VM_HOME: join(root, 'lima'),
          FIXTURE_MEMORY: memory, FIXTURE_DISK: disk, FIXTURE_VM_STARTED: started }, encoding: 'utf8',
      })
      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain(message)
      await expect(access(started)).rejects.toThrow()
    }
  } finally { await rm(root, { recursive: true, force: true }) }
})
