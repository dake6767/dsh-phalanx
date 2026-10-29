import { execFileSync, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout } from 'node:timers/promises'
import type { PlatformDatabaseConnection } from '../../src/domain/platform-database.js'

/** An additional owned rootless server, independent of the built-in fixture. */
export async function startTlsPostgres() {
  if (process.platform !== 'linux') throw Error('TLS PostgreSQL acceptance requires Linux')
  const root = mkdtempSync(join(tmpdir(), 'external-tls-postgres-')),
    name = 'external-pg-' + randomUUID()
  const call = (args: string[]) => execFileSync('podman', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  const pin = JSON.parse(readFileSync('runtime-versions.json', 'utf8')).postgres as { image: string; digest: string }
  const image = pin.image.split(':').slice(0, -1).join(':') + '@' + pin.digest
  let created = false
  const stop = () => {
    if (created) {
      call(['rm', '-f', name])
      created = false
    }
    rmSync(root, { recursive: true, force: true })
  }
  try {
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-days',
        '1',
        '-subj',
        '/CN=localhost',
        '-addext',
        'subjectAltName=DNS:localhost,IP:127.0.0.1',
        '-keyout',
        join(root, 'server.key'),
        '-out',
        join(root, 'server.crt'),
      ],
      { stdio: 'pipe' },
    )
    const port = process.env.DSH_PHALANX_E2E_PORT_BASE === undefined ? '' : String(Number(process.env.DSH_PHALANX_E2E_PORT_BASE) + 18)
    created = true
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
      `127.0.0.1:${port}:5432`,
      '--tmpfs',
      '/var/lib/postgresql/data:rw,size=1m',
      '-v',
      root + ':/fixture-tls:ro',
      '-e',
      'PGDATA=/var/lib/postgresql/fixture-data',
      '-e',
      'POSTGRES_PASSWORD=fixture-only-external-password',
      '--entrypoint',
      '/bin/bash',
      image,
      '-ceu',
      'cp /fixture-tls/server.crt /tmp/server.crt; cp /fixture-tls/server.key /tmp/server.key; chown postgres:postgres /tmp/server.*; chmod 600 /tmp/server.key; exec docker-entrypoint.sh postgres -c shared_buffers=32MB -c ssl=on -c ssl_cert_file=/tmp/server.crt -c ssl_key_file=/tmp/server.key',
    ])
    const deadline = Date.now() + 60_000
    while (spawnSync('podman', ['exec', name, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres'], { stdio: 'pipe' }).status !== 0) {
      if (Date.now() >= deadline) throw Error('External TLS PostgreSQL did not start: ' + call(['logs', name]))
      await setTimeout(100)
    }
    const published = Number(/:(\d+)\s*$/u.exec(call(['port', name, '5432/tcp']))?.[1])
    if (!Number.isInteger(published) || published < 1 || published > 65535) throw Error('Invalid external TLS PostgreSQL port')
    const connection: PlatformDatabaseConnection = {
      host: '127.0.0.1',
      port: published,
      database: 'postgres',
      username: 'postgres',
      password: 'fixture-only-external-password',
      tls: 'require',
    }
    return { connection, ca: readFileSync(join(root, 'server.crt'), 'utf8'), stop }
  } catch (error) {
    try {
      stop()
    } catch (cleanup) {
      throw new AggregateError([error, cleanup], 'External TLS PostgreSQL startup and cleanup failed')
    }
    throw error
  }
}
