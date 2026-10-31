import { postgresUpgradePasswordFile, postgresUpgradeRestoreList } from './postgres-upgrade-connection.js'
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { schemaIdentifier } from './platform-schema-registry.js'
import type { PlatformDatabaseConnection } from '../domain/platform-database.js'
import type { UpgradeDatabaseTools } from './platform-upgrade-database.js'

export interface PostgresUpgradeToolIdentity {
  readonly image: string
  readonly digest: string
  readonly major: number
}
/** Podman exposes raw config hashes; callers may already carry their qualified form. */
function imageConfigId(value: unknown): string {
  const hash = typeof value === 'string' ? /^(?:sha256:)?([a-f0-9]{64})$/u.exec(value)?.[1] : undefined
  if (!hash) throw Error('An immutable PostgreSQL tool image ID is required')
  return 'sha256:' + hash
}
interface PostgresPin {
  readonly image: string
  readonly digest: string
}
// The relay holds the inherited transaction lease until Podman exits, even if its Node caller dies.
const lockDescriptor = process.env.PHALANX_INSTALL_LOCK_FD === undefined ? undefined : Number(process.env.PHALANX_INSTALL_LOCK_FD)
const leaseRelay =
  'import os,signal,subprocess,sys\nfd=int(sys.argv[1]);os.fstat(fd)\nchild=None;cancelled=False\ndef cancel(*_):\n global cancelled\n cancelled=True\n if child is not None:\n  try:child.terminate()\n  except ProcessLookupError:pass\nsignal.signal(signal.SIGTERM,cancel)\nchild=subprocess.Popen(sys.argv[2:],close_fds=True)\nif cancelled:cancel()\nwhile True:\n try:status=child.wait();break\n except InterruptedError:continue\nsys.exit(status)\n'
async function command(args: readonly string[], signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    if (lockDescriptor !== undefined && (!Number.isInteger(lockDescriptor) || lockDescriptor < 3)) throw Error('Invalid database tool lease descriptor')
    const executable = lockDescriptor === undefined ? '/usr/bin/podman' : '/usr/bin/python3'
    const arguments_ = lockDescriptor === undefined ? args : ['-c', leaseRelay, '3', '/usr/bin/podman', ...args]
    const child = spawn(executable, arguments_, {
      stdio: lockDescriptor === undefined ? ['ignore', 'pipe', 'ignore'] : ['ignore', 'pipe', 'ignore', lockDescriptor],
      signal,
    })
    let output = '',
      exceeded = false
    child.stdout!.setEncoding('utf8')
    child.stdout!.on('data', chunk => {
      if (output.length + String(chunk).length > 256 * 1024) {
        exceeded = true
        child.kill('SIGTERM')
      } else output += String(chunk)
    })
    let failed = false
    child.once('error', () => {
      failed = true
    })
    child.once('close', code =>
      code === 0 && !exceeded && !failed
        ? resolve(output)
        : reject(Error('PostgreSQL archive tool failed; keep the verified backup and inspect database availability')),
    )
  })
}
/** Resolve once before downtime; every later invocation forbids pulls and uses this digest. */
export async function preparePostgresUpgradeTools(
  major: number,
  selection: 'builtin' | 'external',
  pin: PostgresPin,
  mirror = '',
): Promise<PostgresUpgradeToolIdentity> {
  if (
    !Number.isInteger(major) ||
    major < 14 ||
    !/^docker.io\/library\/postgres:[0-9][a-zA-Z0-9.-]*$/u.test(pin.image) ||
    !/^sha256:[a-f0-9]{64}$/u.test(pin.digest)
  )
    throw Error('Invalid PostgreSQL archive tool identity')
  if (selection === 'builtin' && Number(pin.image.split(':').at(-1)!.split('.')[0]) !== major)
    throw Error('Built-in PostgreSQL tool major differs from the server')
  if (selection === 'external' && Number(pin.image.split(':').at(-1)!.split('.')[0]) === major) {
    // Reuse the known pin only after the same identity, platform and tool checks as a fresh pull.
    try {
      const cached = JSON.parse(await command(['image', 'inspect', 'docker.io/library/postgres@' + pin.digest])) as {
        Digest?: string
        Id?: string
        Os?: string
        Architecture?: string
      }[]
      return await verifiedTools(cached, major, pin.digest)
    } catch {
      // A missing or unusable cache entry still requires official tools of this server's major.
    }
  }
  const reference = selection === 'builtin' ? 'docker.io/library/postgres@' + pin.digest : `docker.io/library/postgres:${major}-bookworm`
  let image: { Digest?: string; Id?: string; Os?: string; Architecture?: string }[]
  try {
    image = JSON.parse(await command(['image', 'inspect', reference])) as typeof image
  } catch {
    const address = mirror ? new URL(mirror) : undefined
    if (address && (!['https:', 'http:'].includes(address.protocol) || address.username || address.password)) throw Error('Invalid PostgreSQL tool mirror')
    const transport = address ? address.host + address.pathname + reference.replace('docker.io/', '') : reference
    await command(['pull', '--quiet', transport])
    image = JSON.parse(await command(['image', 'inspect', transport])) as typeof image
  }
  return verifiedTools(image, major, selection === 'builtin' ? pin.digest : undefined)
}
async function verifiedTools(
  image: { Digest?: string; Id?: string; Os?: string; Architecture?: string }[],
  major: number,
  digest?: string,
): Promise<PostgresUpgradeToolIdentity> {
  const found = image[0]
  if (
    image.length !== 1 ||
    !found ||
    !/^sha256:[a-f0-9]{64}$/u.test(found.Digest ?? '') ||
    found.Os !== 'linux' ||
    found.Architecture !== (process.arch === 'arm64' ? 'arm64' : 'amd64') ||
    (digest !== undefined && found.Digest !== digest)
  )
    throw Error('PostgreSQL archive tool digest or platform differs')
  const fixed = imageConfigId(found.Id) // Content-addressed config includes every layer identity; never tag a digest as a name.
  for (const tool of ['pg_dump', 'pg_restore']) {
    const output = await command(['run', '--rm', '--pull=never', '--network=none', fixed, tool, '--version'])
    if (!new RegExp('^' + tool + ' \\(PostgreSQL\\) ' + major + '\\.', 'u').test(output)) throw Error('PostgreSQL archive tool must match the server major')
  }
  return { image: fixed, digest: found.Digest!, major }
}
/** Credentials exist only in an owned private file, mounted into one short-lived tool container. */
export class PostgresUpgradeTools implements UpgradeDatabaseTools {
  constructor(private readonly identity: PostgresUpgradeToolIdentity) {
    if (!identity || !/^sha256:[a-f0-9]{64}$/u.test(identity.digest) || !Number.isInteger(identity.major) || identity.major < 14)
      throw Error('An immutable PostgreSQL tool identity is required')
    this.identity = { ...identity, image: imageConfigId(identity.image) }
  }
  private async use<T>(
    connection: PlatformDatabaseConnection,
    directory: string,
    action: (run: (args: readonly string[]) => Promise<string>, work: string) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const cached = JSON.parse(await command(['image', 'inspect', this.identity.image])) as { Id: string; Digest: string }[]
    if (cached.length !== 1 || imageConfigId(cached[0]!.Id) !== this.identity.image || cached[0]!.Digest !== this.identity.digest)
      throw Error('Prepared PostgreSQL archive tool identity is unavailable')
    const work = join(directory, '.database-tool-' + randomUUID())
    mkdirSync(work, { mode: 0o700 })
    try {
      writeFileSync(join(work, 'pgpass'), postgresUpgradePasswordFile(connection), { mode: 0o600, flag: 'wx' })
      if (connection.ca !== undefined) writeFileSync(join(work, 'ca.pem'), connection.ca, { mode: 0o600, flag: 'wx' })
      const environment = {
        PGHOST: connection.host,
        PGPORT: String(connection.port),
        PGDATABASE: connection.database,
        PGUSER: connection.username,
        PGPASSFILE: '/credentials/pgpass',
        PGSSLMODE: connection.tls,
        PGCONNECT_TIMEOUT: '10',
        ...(connection.ca === undefined ? {} : { PGSSLROOTCERT: '/credentials/ca.pem' }),
      }
      const run = async (args: readonly string[]) => {
        const name = 'phalanx-upgrade-tool-' + randomUUID()
        try {
          return await command(
            [
              'run',
              '--rm',
              '--name',
              name,
              '--pull=never',
              '--network=host',
              '--label',
              'dsh.phalanx.upgrade-archive-owner=' + createHash('sha256').update(directory).digest('hex'),
              '--user=0:0',
              '--volume',
              directory + ':/work:rw',
              '--volume',
              work + ':/credentials:ro',
              ...Object.entries(environment).flatMap(([key, value]) => ['--env', key + '=' + value]),
              this.identity.image,
              ...args,
            ],
            signal,
          )
        } finally {
          await command(['rm', '--force', '--ignore', name])
        }
      }
      return await action(run, work)
    } finally {
      rmSync(work, { recursive: true, force: true })
    }
  }
  async dump(connection: PlatformDatabaseConnection, schemas: readonly string[], destination: string, signal?: AbortSignal): Promise<void> {
    if (!schemas.length) throw Error('Refusing to export an empty registered schema selection')
    for (const name of schemas) schemaIdentifier(name)
    writeFileSync(destination, '', { mode: 0o600, flag: 'wx' })
    await this.use(
      connection,
      dirname(destination),
      async run => {
        await run(['pg_dump', '--format=custom', '--file=/work/platform.pgdump', '--strict-names', ...schemas.flatMap(name => ['--schema', name])])
      },
      signal,
    )
  }
  async restore(connection: PlatformDatabaseConnection, archive: string, before: string, after: string, retainedSchemas: readonly string[]): Promise<void> {
    await this.use(connection, dirname(archive), async (run, work) => {
      const list = await run(['pg_restore', '--list', '/work/platform.pgdump'])
      writeFileSync(join(work, 'restore.list'), postgresUpgradeRestoreList(list, retainedSchemas), { mode: 0o600 })
      writeFileSync(join(work, 'before.sql'), before, { mode: 0o600 })
      writeFileSync(join(work, 'after.sql'), after, { mode: 0o600 })
      // A failed producer never emits COMMIT: psql closes and rolls the open transaction back.
      // Stream the archive instead of writing a second full SQL copy beside the custom dump.
      writeFileSync(
        join(work, 'restore.sh'),
        `#!/bin/bash
set -o pipefail
{
  printf 'BEGIN;\\n' || exit 1
  cat /credentials/before.sql || exit 1
  pg_restore --use-list=/credentials/restore.list --exit-on-error --file=- /work/platform.pgdump || exit 1
  cat /credentials/after.sql || exit 1
  printf '\\nCOMMIT;\\n'
} | psql -X --set=ON_ERROR_STOP=1 --file=-
`,
        { mode: 0o600 },
      )
      await run(['bash', '/credentials/restore.sh'])
    })
  }
}
