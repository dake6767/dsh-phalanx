import { execFileSync, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createServer } from 'node:net'
import { setTimeout } from 'node:timers/promises'

export interface PostgresFixtureInfo {
  readonly host: string
  readonly port: number
  readonly password: string
  readonly container: string
  readonly command: readonly string[]
  readonly environment: Readonly<Record<string, string>>
  readonly root: string
}

/** One real PG container per Vitest invocation; workers use independent databases. */
export async function startPostgresFixture() {
  const root = mkdtempSync(join(tmpdir(), 'phalanx-postgres-')),
    name = 'phalanx-postgres-' + randomUUID()
  const password = 'fixture-only-postgres-password',
    environment: Record<string, string> = { PATH: process.env.PATH ?? '/usr/bin:/bin' }
  const version = JSON.parse(readFileSync(resolve('package.json'), 'utf8')).version as string
  const pin = JSON.parse(readFileSync(resolve('runtime-versions.json'), 'utf8')).postgres as { image: string; digest: string }
  const image = pin.image.split(':').slice(0, -1).join(':') + '@' + pin.digest
  const locks: string[] = []
  let guestCommand: string[] = [],
    publishedPort: number | undefined,
    forwardedPort: number | undefined
  let command = ['podman'],
    sshHost: string | undefined,
    container = false,
    tunnel = false
  let socketDirectory: string | undefined
  const call = (args: readonly string[], check = true) => {
    const result = spawnSync(command[0]!, [...command.slice(1), ...args], {
      encoding: 'utf8',
      env: { ...process.env, ...environment },
      stdio: ['ignore', 'pipe', args[0] === 'pull' ? 'inherit' : 'pipe'],
    })
    if (check && result.status !== 0) throw Error(`PG fixture runtime failed: ${result.stderr || result.error?.message || result.status}`)
    return result
  }
  const lock = (action: string, path: string) =>
    execFileSync('python3', ['scripts/dev/operation-lock.py', action, path, String(process.pid)], { stdio: 'pipe' })
  const exists = (kind: 'container' | 'image', identifier: string) => {
    const result = call([kind, 'exists', identifier], false)
    if (result.status === 0) return true
    if (result.status === 1) return false
    throw Error(`PG fixture ${kind} lookup failed: ${result.stderr || result.error?.message || result.status}`)
  }
  const checkPortReleased = (port: number, guest = false) => {
    const probe =
      'import socket,sys,time,errno\nfor attempt in range(40):\n s=socket.socket(); s.settimeout(.2); status=s.connect_ex(("127.0.0.1",int(sys.argv[1]))); s.close()\n if status==errno.ECONNREFUSED: sys.exit(0)\n time.sleep(.05)\nsys.exit("PG fixture listener still reachable or unavailable: "+str(status))'
    const args = ['python3', '-c', probe, String(port)]
    const commandLine = guest ? [...guestCommand, ...args] : args
    execFileSync(commandLine[0]!, commandLine.slice(1), { env: { ...process.env, ...environment }, stdio: 'pipe' })
  }
  const stop = () => {
    const failures: unknown[] = []
    const attempt = (operation: () => void) => {
      try {
        operation()
      } catch (error) {
        failures.push(error)
      }
    }
    if (tunnel)
      attempt(() => {
        execFileSync('ssh', ['-F', join(root, 'ssh.conf'), '-S', join(socketDirectory!, 'control'), '-O', 'exit', sshHost!], { stdio: 'pipe' })
        tunnel = false
      })
    if (container) {
      attempt(() => {
        if (exists('container', name)) {
          const logs = call(['logs', name], false)
          writeFileSync(join(root, 'container.log'), logs.stdout + logs.stderr, { mode: 0o600 })
          attempt(() => {
            call(['stop', '--time', '20', name])
          })
          if (exists('container', name)) call(['rm', name])
        }
        if (exists('container', name)) throw Error('PG fixture container remains after cleanup')
        container = false
      })
    }
    if (publishedPort !== undefined)
      attempt(() => {
        checkPortReleased(publishedPort!, true)
      })
    if (forwardedPort !== undefined)
      attempt(() => {
        checkPortReleased(forwardedPort!)
      })
    if (!tunnel && socketDirectory)
      attempt(() => {
        rmSync(socketDirectory!, { recursive: true, force: true })
        socketDirectory = undefined
      })
    for (const path of [...locks].reverse())
      attempt(() => {
        lock('release', path)
        locks.splice(locks.indexOf(path), 1)
      })
    if (failures.length) {
      writeFileSync(
        join(root, 'cleanup-error.json'),
        JSON.stringify({
          container: name,
          publishedPort,
          forwardedPort,
          socketDirectory,
          failures: failures.map(error => (error instanceof Error ? error.message : String(error))),
        }),
        { mode: 0o600 },
      )
      throw new AggregateError(failures, `PG fixture cleanup failed; diagnostics retained at ${root}`)
    }
    rmSync(root, { recursive: true, force: true })
  }
  try {
    if (process.platform === 'darwin') {
      const vm = process.env.DSH_PHALANX_VM_HOME ?? join(homedir(), '.lima-dsh-phalanx-' + version)
      if (
        readFileSync(join(vm, '.dsh-phalanx-checkout'), 'utf8').trim() !== resolve('.') ||
        readFileSync(join(vm, '.dsh-phalanx-version'), 'utf8').trim() !== version
      )
        throw Error('Start the matching owned development VM before running PG tests')
      const cache = readFileSync(join(vm, '.dsh-phalanx-image-cache'), 'utf8').trim()
      for (const path of [join(vm, '.operation-lock'), join(cache, '.operation-lock')]) {
        lock('acquire', path)
        locks.push(path)
      }
      environment.LIMA_HOME = vm
      const guest = ['shell', '--workdir=/mnt/dsh-phalanx', 'development']
      guestCommand = ['limactl', ...guest]
      const uid = execFileSync('limactl', [...guest, 'id', '-u', 'dsh-development-builder'], {
        encoding: 'utf8',
        env: { ...process.env, ...environment },
      }).trim()
      if (!/^\d+$/u.test(uid)) throw Error('Invalid development builder identity')
      command = [
        'limactl',
        ...guest,
        'sudo',
        '-u',
        'dsh-development-builder',
        'env',
        '-i',
        'HOME=/var/lib/dsh-phalanx-dev/builder',
        'PATH=/usr/bin:/bin',
        `XDG_RUNTIME_DIR=/run/user/${uid}`,
        `DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/${uid}/bus`,
        'podman',
      ]
      const ssh = execFileSync('limactl', ['show-ssh', '--format=config', 'development'], { encoding: 'utf8', env: { ...process.env, ...environment } })
      writeFileSync(join(root, 'ssh.conf'), ssh, { mode: 0o600 })
      sshHost = /^Host\s+(\S+)/mu.exec(ssh)?.[1]
      if (!sshHost) throw Error('The development VM did not provide SSH configuration')
    }
    if (!exists('image', image)) call(['pull', image])
    const base = process.env.DSH_PHALANX_E2E_PORT_BASE
    const requested = base === undefined ? '' : String(Number(base) + 19)
    if (requested !== '' && (!/^\d+$/u.test(requested) || Number(requested) < 1024 || Number(requested) > 65535)) throw Error('Invalid PG fixture port range')
    container = true
    // Cover the image's default VOLUME; test data stays in the owned container layer.
    // This avoids an orphan data volume if the file runner must terminate Vitest.
    call([
      'run',
      '-d',
      '--name',
      name,
      '--label',
      'dsh.phalanx.test-owner=' + name,
      '--network',
      'pasta',
      '-p',
      `127.0.0.1:${requested}:5432`,
      '--tmpfs',
      '/var/lib/postgresql/data:rw,size=1m',
      '-e',
      'PGDATA=/var/lib/postgresql/fixture-data',
      '-e',
      `POSTGRES_PASSWORD=${password}`,
      image,
      '-c',
      'shared_buffers=32MB',
      '-c',
      'max_connections=100',
      '-c',
      'work_mem=2MB',
    ])
    const deadline = Date.now() + 60_000
    while (call(['exec', name, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres'], false).status !== 0) {
      if (Date.now() >= deadline) throw Error('The PG test container did not become ready: ' + call(['logs', name], false).stdout)
      await setTimeout(50)
    }
    const remote = Number(/:(\d+)\s*$/u.exec(call(['port', name, '5432/tcp']).stdout)?.[1])
    if (!Number.isInteger(remote) || remote < 1 || remote > 65535) throw Error('Invalid PG test listener')
    publishedPort = remote
    let port = remote
    if (sshHost) {
      const socket = createServer()
      await new Promise<void>((accept, reject) => {
        socket.once('error', reject)
        socket.listen(0, '127.0.0.1', accept)
      })
      const address = socket.address()
      if (!address || typeof address === 'string') throw Error('No local PG forwarding port')
      port = address.port
      forwardedPort = port
      await new Promise<void>((accept, reject) => socket.close(error => (error ? reject(error) : accept())))
      // Retry evidence paths exceed macOS's Unix socket limit; keep only the control socket short.
      socketDirectory = mkdtempSync('/tmp/phalanx-pg-')
      writeFileSync(join(root, 'ssh-control.json'), JSON.stringify({ directory: socketDirectory }), { mode: 0o600 })
      execFileSync(
        'ssh',
        [
          '-F',
          join(root, 'ssh.conf'),
          '-M',
          '-S',
          join(socketDirectory, 'control'),
          '-fNT',
          '-o',
          'ExitOnForwardFailure=yes',
          '-L',
          `127.0.0.1:${port}:127.0.0.1:${remote}`,
          sshHost,
        ],
        { stdio: 'pipe' },
      )
      tunnel = true
    }
    const info: PostgresFixtureInfo = { host: '127.0.0.1', port, password, container: name, command, environment, root }
    return { info, stop }
  } catch (error) {
    try {
      stop()
    } catch (cleanup) {
      throw new AggregateError([error, cleanup], 'PG fixture startup and cleanup failed')
    }
    throw error
  }
}
