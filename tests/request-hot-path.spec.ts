import { createServer } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocket, WebSocketServer } from 'ws'
import { expect, it } from 'vitest'
import { createCommunityApplication } from '../src/composition/community-application.js'
import { CommunityInstanceLifecycle } from '../src/use-cases/community-instance-lifecycle.js'
import { execFileText } from '../src/adapters/runtime-command.js'
import { readBootstrapCredential } from '../src/adapters/bootstrap-credential.js'

it('forwards HTTP, streams and upgrades without runtime commands, reuses connections and never replays a failed write', async () => {
  const root = await mkdtemp(join(tmpdir(), 'request-hot-path-'))
  const log = join(root, 'commands')
  const command = async (name: string) => { await execFileText(process.execPath, ['-e', "require('node:fs').appendFileSync(process.argv[1], process.argv[2]+'\\n')", log, name]) }
  let stopped!: () => void
  const carrierStopped = new Promise<void>(resolve => { stopped = resolve })
  const peers: number[] = [], forwarded: string[] = []
  let active = true, writes = 0, finishStream!: () => void
  const upstream = createServer((request, response) => {
    if (request.url === '/launch') { response.writeHead(303, { location: '/', 'set-cookie': 'dsh_fixture=accepted; Path=/' }); response.end(); return }
    peers.push(request.socket.remotePort!); forwarded.push(request.headers.cookie ?? '')
    if (request.url === '/write') { writes++; active = false; request.socket.destroy(); return }
    if (request.url === '/events') {
      response.writeHead(200, { 'content-type': 'text/event-stream' }); response.write('data: first\n\n')
      finishStream = () => { response.end('data: last\n\n') }; return
    }
    response.end('resource')
  })
  const sockets = new WebSocketServer({ server: upstream })
  sockets.on('connection', ws => { ws.on('message', value => ws.send(value.toString())) })
  await new Promise<void>(resolve => { upstream.listen(0, '127.0.0.1', resolve) })
  const address = upstream.address(); if (!address || typeof address === 'string') throw Error('No upstream address')
  const target = `http://127.0.0.1:${address.port}`
  const runtime = new CommunityInstanceLifecycle({ rebuild: async () => [],
    start: async userId => { await command('run'); active = true; return { userId, processId: 101, origin: target, launchUrl: target + '/launch' } },
    alive: async () => { await command('ps'); return active }, stop: async () => { await command('rm'); setImmediate(stopped) }, detach: async () => {},
  }, () => ({ url: 'http://127.0.0.1/model', token: 'fixture' }))
  const app = createCommunityApplication({ listen: { host: '127.0.0.1', port: 0 }, sessionSecret: 'request-hot-path-fixture-secret-32-bytes',
    idleReclaimSeconds: 0, runtime: { command: '/unused', args: [], dataRoot: join(root, 'data'), defaultModel: { provider: 'deepseek-official', model: 'fixture', upstream: { baseUrl: 'http://127.0.0.1:1' } } } }, { runtime })
  const cookies = (response: Response) => response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
  try {
    const origin = await app.start()
    const bootstrap = await fetch(origin + '/bootstrap', { method: 'POST', redirect: 'manual', headers: { origin, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ credential: readBootstrapCredential(join(root, 'data'))!.credential, username: 'admin', password: 'password' }) })
    const admin = cookies(bootstrap)
    const created = await fetch(origin + '/admin/api/accounts', { method: 'POST', headers: { origin, cookie: admin, 'content-type': 'application/json' }, body: JSON.stringify({ username: 'member', password: 'password', email: '' }) })
    const { spaceId } = await created.json() as { spaceId: string }
    const login = await fetch(origin + '/login', { method: 'POST', redirect: 'manual', headers: { origin, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ username: 'member', password: 'password' }) })
    const cookie = cookies(login), mount = `/app/${spaceId}/`
    for (const path of ['', 'asset.js', 'api/data']) {
      const response = await fetch(origin + mount + path, { headers: { cookie } }); expect(response.status).toBe(200); expect(await response.text()).toBe('resource')
    }
    expect(new Set(peers).size).toBe(1)
    expect(forwarded.every(value => !value.includes('dsh-phalanx_'))).toBe(true)
    const stream = await fetch(origin + mount + 'events', { headers: { cookie } })
    const reader = stream.body!.getReader()
    expect(new TextDecoder().decode((await reader.read()).value)).toBe('data: first\n\n')
    finishStream()
    expect(new TextDecoder().decode((await reader.read()).value)).toBe('data: last\n\n')
    expect((await reader.read()).done).toBe(true)
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(origin.replace(/^http/u, 'ws') + mount + 'socket', { headers: { cookie, origin } })
      ws.on('error', reject); ws.once('open', () => { ws.send('echo') })
      ws.once('message', value => { expect(value.toString()).toBe('echo'); ws.close() }); ws.once('close', () => { resolve() })
    })
    expect((await readFile(log, 'utf8')).trim().split('\n')).toEqual(['run'])
    const failed = await fetch(origin + mount + 'write', { method: 'POST', headers: { cookie }, body: 'one operation' })
    expect(failed.status).toBe(502)
    await carrierStopped
    expect(writes).toBe(1); expect(runtime.status('member').state).toBe('stopped')
    expect((await readFile(log, 'utf8')).trim().split('\n')).toEqual(['run', 'ps', 'rm'])
    const disabled = await fetch(origin + '/admin/api/accounts/member/actions', { method: 'POST', headers: { origin, cookie: admin, 'content-type': 'application/json' }, body: JSON.stringify({ action: 'set-disabled', disabled: true }) })
    expect(disabled.status).toBe(200)
    expect((await fetch(origin + mount, { headers: { cookie }, redirect: 'manual' })).headers.get('location')).toBe('/login')
    expect((await readFile(log, 'utf8')).trim().split('\n')).toEqual(['run', 'ps', 'rm'])
  } finally {
    finishStream?.(); for (const ws of sockets.clients) ws.terminate()
    await app.stop(); sockets.close(); upstream.closeAllConnections()
    await new Promise<void>((resolve, reject) => { upstream.close(error => error ? reject(error) : resolve()) })
    await rm(root, { recursive: true, force: true })
  }
})
