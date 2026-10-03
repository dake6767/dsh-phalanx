import { createHash, randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { setTimeout } from 'node:timers'
import { WebSocketServer } from 'ws'

const token = `fixture-launch-token-${randomBytes(8).toString('hex')}`
const sessionOwner = process.env.HOME ?? String(process.pid)
const session = `fixture-session-${createHash('sha256').update(sessionOwner).digest('hex').slice(0, 16)}`
const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://fixture.invalid')
  if (request.method === 'GET' && url.pathname === '/' && url.searchParams.get('token') === token) {
    response.writeHead(303, {
      location: '/',
      'set-cookie': `dsh_fixture_session=${session}; Path=/; HttpOnly; SameSite=Strict`,
    })
    response.end()
    return
  }
  if (!request.headers.cookie?.split(';').some(value => value.trim() === `dsh_fixture_session=${session}`)) {
    response.writeHead(401)
    response.end('Unauthorized')
    return
  }
  if (/dsh-phalanx_(?:session|last_account)=/u.test(request.headers.cookie)) {
    response.writeHead(400)
    response.end('platform cookie leaked to runtime')
    return
  }
  if (request.method === 'POST' && url.pathname === '/api/session/list') {
    request.resume()
    const activityFile = process.env.DSH_PHALANX_FIXTURE_ACTIVITY_FILE
    let running = false
    if (activityFile !== undefined) {
      try {
        running = readFileSync(activityFile, 'utf8').trim() === 'running'
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error
      }
    }
    const send = () => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({
        result: { ok: true, value: { items: [{ sessionId: 'fixture-session', running }] } },
      }))
    }
    const delayMs = Number.parseInt(process.env.DSH_PHALANX_FIXTURE_ACTIVITY_DELAY_MS ?? '0', 10)
    if (delayMs > 0) setTimeout(send, delayMs)
    else send()
    return
  }
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('fixture did not expose its TCP address')
  response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
  response.end(`fixture runtime pid=${process.pid} port=${address.port}`)
})

const sockets = new WebSocketServer({ noServer: true })
server.on('upgrade', (request, socket, head) => {
  if (!request.headers.cookie?.split(';').some(value => value.trim() === `dsh_fixture_session=${session}`)) {
    socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
    return
  }
  sockets.handleUpgrade(request, socket, head, ws => { ws.on('message', data => ws.send(data.toString())) })
})

server.listen(0, '127.0.0.1', () => {
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('fixture did not bind')
  console.log(`dsh web: http://127.0.0.1:${address.port}/?token=${token}`)
})

process.on('SIGTERM', () => {
  for (const socket of sockets.clients) socket.terminate()
  sockets.close()
  server.close(() => process.exit(0))
})
