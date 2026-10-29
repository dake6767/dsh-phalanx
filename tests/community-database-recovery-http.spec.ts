import { readBootstrapCredential } from '../src/adapters/bootstrap-credential.js'
import { mkdtemp, rm, rename, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Pool } from 'pg'
import { expect, it } from 'vitest'
import { createSupervisedCommunityApplication } from '../src/composition/community-supervised-application.js'
import { withTestDatabase } from './support/community-application.js'
import { FilePlatformDatabaseConfig } from '../src/adapters/platform-database-config.js'

it('keeps fresh platform and admin navigation readable on offline startup and rebuilds after the same database recovers', async () => {
  const root = await mkdtemp(join(tmpdir(), 'database-recovery-http-'))
  const config = withTestDatabase({
    listen: { host: '127.0.0.1', port: 0 },
    runtime: {
      command: '/unused-runtime',
      args: [],
      dataRoot: root,
      defaultModel: { provider: 'deepseek-official', model: 'fixture', upstream: { baseUrl: 'http://127.0.0.1:1' } },
    },
  })
  const saved = FilePlatformDatabaseConfig.open(config.platformDatabaseConfigFile!, root),
    connection = saved.connection
  FilePlatformDatabaseConfig.select(config.platformDatabaseConfigFile!, root, connection, 'builtin')
  const control = new Pool({ ...connection, database: 'postgres', user: connection.username })
  let retry: (() => Promise<void>) | undefined
  const app = createSupervisedCommunityApplication(
    config,
    {},
    {
      schedule: task => {
        retry = async () => {
          retry = undefined
          await task()
        }
        return () => {
          retry = undefined
        }
      },
    },
  )
  const unavailable = async (origin: string) => {
    for (const path of ['/', '/login', '/admin/settings']) {
      const response = await fetch(origin + path, { headers: { 'accept-language': 'zh-CN' }, redirect: 'manual' })
      expect(response.status).toBe(503)
      expect(response.headers.get('cache-control')).toBe('no-store')
      expect(await response.text()).toContain('平台数据库暂时不可用')
    }
    expect((await fetch(origin + '/login', { method: 'POST', body: 'username=admin' })).status).toBe(503)
  }
  try {
    await control.query(`ALTER DATABASE "${connection.database}" ALLOW_CONNECTIONS false`)
    const origin = await app.start()
    await unavailable(origin)
    expect(retry).toBeTypeOf('function')
    await control.query(`ALTER DATABASE "${connection.database}" ALLOW_CONNECTIONS true`)
    await retry!()
    expect((await fetch(origin + '/login', { redirect: 'manual' })).status).not.toBe(503)
    const form = (path: string, body: Record<string, string>) =>
      fetch(origin + path, {
        method: 'POST',
        redirect: 'manual',
        headers: { origin, 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(body),
      })
    const bootstrap = await form('/bootstrap', { credential: readBootstrapCredential(root)!.credential, username: 'admin', password: 'password' })
    expect(bootstrap.status).toBe(303)
    const cookie = bootstrap.headers
      .getSetCookie()
      .map(value => value.split(';')[0])
      .join('; ')
    expect(
      (
        await fetch(origin + '/admin/api/accounts', {
          method: 'POST',
          headers: { cookie, origin, 'content-type': 'application/json' },
          body: JSON.stringify({ username: 'member', email: 'member@example.test', password: 'password' }),
        })
      ).status,
    ).toBe(201)
    const memberLogin = await form('/login', { username: 'member', password: 'password' })
    expect(memberLogin.status).toBe(303)
    const memberCookie = memberLogin.headers
      .getSetCookie()
      .map(value => value.split(';')[0])
      .join('; ')
    expect((await fetch(origin + '/admin/api/session', { headers: { cookie: memberCookie } })).status).toBe(403)
    await control.query(`ALTER DATABASE "${connection.database}" ALLOW_CONNECTIONS false`)
    await control.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1', [connection.database])
    await expect.poll(async () => (await fetch(origin + '/login', { redirect: 'manual' })).status).toBe(503)
    await unavailable(origin)
    await expect.poll(() => typeof retry).toBe('function')
    await control.query(`ALTER DATABASE "${connection.database}" ALLOW_CONNECTIONS true`)
    const editor = new Pool({ ...connection, user: connection.username })
    try {
      await editor.query("UPDATE dsh_phalanx.accounts SET disabled=true,session_epoch=session_epoch+1 WHERE username='member'")
    } finally {
      await editor.end()
    }
    await retry!()
    expect((await fetch(origin + '/admin/api/system-status', { headers: { cookie } })).status).toBe(200)
    expect((await fetch(origin + '/admin/api/session', { headers: { cookie: memberCookie } })).status).toBe(401)
  } finally {
    await control.query(`ALTER DATABASE "${connection.database}" ALLOW_CONNECTIONS true`)
    await app.stop()
    await control.end()
    await rm(root, { recursive: true, force: true })
  }
})

it('keeps a missing master key closed for operator recovery and never generates a replacement', async () => {
  const root = await mkdtemp(join(tmpdir(), 'key-recovery-http-'))
  const config = withTestDatabase({
    listen: { host: '127.0.0.1', port: 0 },
    runtime: {
      command: '/unused-runtime',
      args: [],
      dataRoot: root,
      defaultModel: { provider: 'deepseek-official', model: 'fixture', upstream: { baseUrl: 'http://127.0.0.1:1' } },
    },
  })
  const master = FilePlatformDatabaseConfig.open(config.platformDatabaseConfigFile!, root).security.masterKeyPath
  await rename(master, master + '.lost')
  let scheduled = 0
  const app = createSupervisedCommunityApplication(
    config,
    {},
    {
      schedule: () => {
        scheduled++
        return () => {}
      },
    },
  )
  try {
    const origin = await app.start(),
      response = await fetch(origin + '/admin/settings')
    expect(response.status).toBe(503)
    expect(await response.text()).toContain('Platform configuration requires recovery')
    expect(scheduled).toBe(0)
    await expect(stat(master)).rejects.toMatchObject({ code: 'ENOENT' })
  } finally {
    await app.stop()
    await rename(master + '.lost', master)
    await rm(root, { recursive: true, force: true })
  }
})
