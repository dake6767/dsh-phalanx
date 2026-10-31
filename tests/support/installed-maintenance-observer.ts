// Explicit native acceptance barriers at the systemd, PostgreSQL and nft seams.
import { createHash, randomUUID } from 'node:crypto'
import { chown, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Pool, type PoolClient } from 'pg'
import { request } from 'playwright'
import { expect } from 'vitest'
import { execFileText } from '../../src/adapters/runtime-command.js'
import { cleanupOwned } from '../fixtures/owned-cleanup.js'

interface ExternalFixture {
  host: string
  port: number
  database: string
  username: string
  password: string
}

/** Shared root-owned input for installed-host scenarios; its bytes identify resumed work. */
export async function installedExternalDatabaseFixture(path: string) {
  const info = await lstat(path)
  if (!info.isFile() || info.uid !== 0 || (info.mode & 0o777) !== 0o600) throw Error('Requires the original root-owned external fixture file')
  const raw = await readFile(path)
  const connection: ExternalFixture = JSON.parse(raw.toString('utf8'))
  if (
    connection.host !== '127.0.0.1' ||
    !Number.isInteger(connection.port) ||
    connection.port < 1 ||
    connection.port > 65535 ||
    !connection.database ||
    !connection.username ||
    !connection.password
  )
    throw Error('Requires an owned loopback PostgreSQL fixture')
  return { connection, configurationSha256: createHash('sha256').update(raw).digest('hex'), bootstrap: externalBootstrap(connection) }
}

function externalBootstrap(value: ExternalFixture): Record<string, string> {
  return {
    databaseKind: 'external',
    databaseHost: value.host,
    databasePort: String(value.port),
    databaseName: value.database,
    databaseUsername: value.username,
    databasePassword: value.password,
    databaseTls: 'disable',
  }
}

export class InstalledMaintenanceObserver {
  private readonly nonce = randomUUID()
  private readonly table = 'dsh_maintenance_probe_' + this.nonce.replaceAll('-', '')
  private readonly dropinDirectory = '/var/lib/dsh-phalanx/.config/systemd/user/dsh-phalanx.service.d'
  private readonly dropin = join(this.dropinDirectory, 'maintenance-probe-' + this.nonce + '.conf')
  private directory: string | undefined
  private dropinWritten = false
  private tableWritten = false
  private pool: Pool
  private lock: PoolClient | undefined
  private uid = 0
  private gid = 0
  private source = ''
  private operation = ''
  readonly samples: { phase: string; locale: string; address: string; status: number }[] = []

  private constructor(readonly connection: ExternalFixture) {
    this.pool = new Pool({ ...connection, user: connection.username, ssl: false })
  }

  static async open(path: string): Promise<InstalledMaintenanceObserver> {
    return new InstalledMaintenanceObserver((await installedExternalDatabaseFixture(path)).connection)
  }

  bootstrap(): Record<string, string> {
    return externalBootstrap(this.connection)
  }

  private execute(program: string, args: string[]): Promise<string> {
    return execFileText(program, args, { timeout: 30000, maxBuffer: 1024 * 1024 })
  }

  private reload(): Promise<string> {
    return this.execute('runuser', ['-u', 'dsh-phalanx', '--', 'env', `XDG_RUNTIME_DIR=/run/user/${this.uid}`, 'systemctl', '--user', 'daemon-reload'])
  }

  async arm(operation: string): Promise<void> {
    if (!/^[a-f\d-]{36}$/u.test(operation)) throw Error('Invalid observed operation')
    this.operation = operation
    this.source = await realpath('/opt/dsh-phalanx/current')
    const home = await stat('/var/lib/dsh-phalanx')
    this.uid = home.uid
    this.gid = home.gid
    if (!this.uid) throw Error('Requires an owned non-root product installation')
    this.directory = await mkdtemp('/tmp/dsh-maintenance-observer-')
    await chown(this.directory, this.uid, this.gid)
    const script = join(this.directory, 'stop.py')
    await writeFile(
      script,
      `import pathlib,time
root=pathlib.Path(__file__).parent
try:
    (root/'stopped').write_text('stopped')
    deadline=time.monotonic()+120
    while not (root/'released').exists():
        if time.monotonic()>deadline:raise RuntimeError('Owned stop barrier was not released')
        time.sleep(.05)
finally:(root/'finished').write_text('finished')
`,
      { mode: 0o644, flag: 'wx' },
    )
    await chown(script, this.uid, this.gid)
    const created = await mkdir(this.dropinDirectory, { recursive: true })
    if (created) {
      if (created !== this.dropinDirectory) throw Error('Requires the installed service configuration directory')
      await chown(this.dropinDirectory, this.uid, this.gid)
    }
    const directory = await lstat(this.dropinDirectory)
    if (!directory.isDirectory() || directory.uid !== this.uid || directory.gid !== this.gid) throw Error('Unknown service drop-in directory owner')
    await writeFile(this.dropin, `[Service]\nExecStopPost=/usr/bin/python3 ${script}\n`, { mode: 0o644, flag: 'wx' })
    this.dropinWritten = true
    await chown(this.dropin, this.uid, this.gid)
    await this.reload()
    const loaded = await this.execute('runuser', [
      '-u',
      'dsh-phalanx',
      '--',
      'env',
      `XDG_RUNTIME_DIR=/run/user/${this.uid}`,
      'systemctl',
      '--user',
      'show',
      'dsh-phalanx.service',
      '--property=ExecStopPost',
      '--value',
    ])
    expect(loaded).toContain(script)
    // This separately owned test table delays only the executor's marked readiness
    // requests. Member requests remain governed by the actual admission owner.
    const tables = JSON.parse(await this.execute('nft', ['-j', 'list', 'tables'])).nftables
    if (tables.some((row: { table?: { name: string } }) => row.table?.name === this.table)) throw Error('Observer table already exists')
    const rules = `table inet ${this.table} {
 comment "maintenance observer ${this.nonce}"
 chain hold_ready {
  type filter hook output priority -151; policy accept;
  ip daddr 127.0.0.1 tcp dport 18080 meta mark 1146308688 counter drop
 }
}
`
    const ruleFile = join(this.directory, 'observer.nft')
    await writeFile(ruleFile, rules, { mode: 0o600, flag: 'wx' })
    await this.execute('nft', ['-f', ruleFile])
    this.tableWritten = true
  }

  private async phase(): Promise<string> {
    return JSON.parse(await readFile(`/var/lib/dsh-phalanx-updater/${this.operation}/operation.json`, 'utf8')).phase
  }

  private async sample(phase: string, target: string): Promise<void> {
    const client = await request.newContext({ baseURL: 'http://127.0.0.1:18080' })
    try {
      for (const locale of ['en', 'zh-CN']) {
        const response = await client.get('/', { headers: { 'accept-language': locale } })
        expect(response.status()).toBe(503)
        expect(response.headers()['retry-after']).toBe('3')
        expect(response.headers()['content-type']).toContain('text/html')
        expect(await response.body()).toEqual(await readFile(join(target, 'dist', `maintenance.${locale}.html`)))
        expect(await this.phase()).toBe(phase)
        this.samples.push({ phase, locale, address: '127.0.0.1', status: response.status() })
      }
    } finally {
      await client.dispose()
    }
  }

  async observe(): Promise<void> {
    await expect.poll(() => readFile(join(this.directory!, 'stopped'), 'utf8').catch(() => ''), { timeout: 90000 }).toBe('stopped')
    expect(await this.phase()).toBe('stopping')
    this.lock = await this.pool.connect()
    await this.lock.query('BEGIN')
    await this.lock.query('LOCK TABLE dsh_phalanx.usage_records IN ACCESS EXCLUSIVE MODE')
    await writeFile(join(this.directory!, 'released'), 'released', { flag: 'wx' })
    await expect
      .poll(
        async () => {
          const waiting = await this.pool.query<{ present: boolean }>(
            `SELECT EXISTS(SELECT 1 FROM pg_stat_activity a JOIN pg_locks l ON a.pid=l.pid
           WHERE l.relation='dsh_phalanx.usage_records'::regclass AND NOT l.granted
           AND a.datname=current_database() AND a.wait_event_type='Lock') AS present`,
          )
          return (await this.phase()) === 'backing-up' && waiting.rows[0]!.present
        },
        { timeout: 90000 },
      )
      .toBe(true)
    await this.sample('backing-up', this.source)
    await this.lock.query('ROLLBACK')
    this.lock.release()
    this.lock = undefined
    await expect.poll(() => this.phase(), { timeout: 120000 }).toBe('validating')
    // The phase is held by the real SO_MARK request; wait for the verified target
    // listener's page, rather than assuming that recording validating bound it.
    await expect
      .poll(
        async () => {
          try {
            const client = await request.newContext({ baseURL: 'http://127.0.0.1:18080' })
            try {
              const response = await client.get('/', { timeout: 2000 })
              return response.status() === 503 && response.headers()['retry-after'] === '3'
            } finally {
              await client.dispose()
            }
          } catch {
            return false
          }
        },
        { timeout: 60000 },
      )
      .toBe(true)
    await this.sample('validating', await realpath('/opt/dsh-phalanx/current'))
    await this.removeTable()
    await this.removeDropin()
  }

  private async removeTable(): Promise<void> {
    if (!this.tableWritten) return
    const rows = JSON.parse(await this.execute('nft', ['-j', 'list', 'table', 'inet', this.table])).nftables
    if (!rows.some((row: { table?: { comment?: string } }) => row.table?.comment === 'maintenance observer ' + this.nonce))
      throw Error('Observer table ownership changed')
    await this.execute('nft', ['delete', 'table', 'inet', this.table])
    this.tableWritten = false
  }

  private async removeDropin(): Promise<void> {
    if (!this.dropinWritten) return
    await rm(this.dropin, { force: true })
    await this.reload()
    this.dropinWritten = false
  }

  async close(): Promise<void> {
    await cleanupOwned(
      async () => {
        if (this.directory) await writeFile(join(this.directory, 'released'), 'released')
      },
      async () => {
        if (this.lock) {
          try {
            await this.lock.query('ROLLBACK')
          } finally {
            this.lock.release(true)
            this.lock = undefined
          }
        }
      },
      () => this.pool.end(),
      () => this.removeTable(),
      () => this.removeDropin(),
      async () => {
        if (this.directory) {
          if (this.tableWritten || this.dropinWritten) throw Error('Preserving the barrier directory until its OS resources are removed')
          const script = join(this.directory, 'stop.py')
          await expect
            .poll(
              async () => {
                const output = await this.execute('runuser', [
                  '-u',
                  'dsh-phalanx',
                  '--',
                  'env',
                  `XDG_RUNTIME_DIR=/run/user/${this.uid}`,
                  'systemctl',
                  '--user',
                  'show',
                  'dsh-phalanx.service',
                  '--property=ControlPID,SubState',
                ])
                const fields = Object.fromEntries(
                  output
                    .trim()
                    .split('\n')
                    .map(line => line.split('=')),
                )
                if (!/^\d+$/u.test(fields.ControlPID ?? '') || !fields.SubState) throw Error('Barrier service facts are unavailable')
                const command =
                  fields.ControlPID === '0'
                    ? ''
                    : await readFile(`/proc/${fields.ControlPID}/cmdline`, 'utf8').catch(error => {
                        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''
                        throw error
                      })
                if (command.split('\0').includes(script) || fields.SubState.startsWith('stop')) return false
                const files = await readdir(this.directory!)
                return !files.includes('stopped') || files.includes('finished')
              },
              { timeout: 90000 },
            )
            .toBe(true)
          await rm(this.directory, { recursive: true })
        }
      },
    )
  }
}
