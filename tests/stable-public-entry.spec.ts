import { spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { WebSocket, WebSocketServer } from 'ws'
import { MemorySessionRegistry } from '../src/adapters/memory-session-registry.js'
import { Agent, createServer, get } from 'node:http'
import { expect, it } from 'vitest'
import { StablePublicEntry } from '../src/inbound/stable-public-entry.js'

it('reports a permanent startup failure to readiness probes while preserving maintenance admission', async () => {
  let maintenance = false
  const entry = new StablePublicEntry({ host: '127.0.0.1', port: 0 }, { closed: () => maintenance })
  const origin = await entry.start()
  try {
    const temporary = await fetch(origin + '/readyz', { headers: { accept: 'application/json' } })
    expect(temporary.status).toBe(503)
    expect(await temporary.json()).toMatchObject({ code: 'platform-database-unavailable' })
    entry.suspend('configuration')
    for (maintenance of [false, true]) {
      const permanent = await fetch(origin + '/readyz?probe=startup')
      expect(permanent.status).toBe(503)
      expect(await permanent.json()).toMatchObject({ code: 'platform-configuration-unavailable' })
    }
    entry.suspend('migration')
    const migration = await fetch(origin + '/readyz')
    expect(await migration.json()).toMatchObject({ code: 'platform-configuration-unavailable', errorCode: 'migration.failed' })
    entry.suspend('configuration')
    expect(await (await fetch(origin + '/readyz')).json()).not.toHaveProperty('errorCode')
    const mutation = await fetch(origin + '/admin/api/accounts', { method: 'POST', headers: { accept: 'application/json' } })
    expect(mutation.status).toBe(503)
    expect(mutation.headers.get('content-type')).toContain('text/html')
    expect(mutation.headers.get('retry-after')).toBe('3')
    expect(await mutation.text()).toContain('data-platform-maintenance')
  } finally {
    await entry.stop()
  }
})

it('serves safe bilingual diagnostics and hands an existing keep-alive socket to one graph without reparsing it', async () => {
  const entry = new StablePublicEntry({ host: '127.0.0.1', port: 0 }, { closed: () => false })
  const origin = await entry.start(),
    agent = new Agent({ keepAlive: true, maxSockets: 1 })
  const read = (path: string, language = 'en') =>
    new Promise<{ status: number; body: string; port: number }>((resolve, reject) => {
      const request = get(origin + path, { agent, headers: { 'accept-language': language } }, response => {
        const port = response.socket.localPort!
        let body = ''
        response.setEncoding('utf8')
        response.on('data', chunk => {
          body += chunk
        })
        response.on('end', () => {
          resolve({ status: response.statusCode!, body, port })
        })
      })
      request.on('error', reject)
    })
  let registered = 0
  const graph = createServer((request, response) => {
    response.end(request.headers.host)
  })
  try {
    const diagnostic = await read('/admin/settings', 'zh-CN')
    expect(diagnostic.status).toBe(503)
    expect(diagnostic.body).toContain('平台数据库暂时不可用')
    entry.bind(graph, () => {
      registered++
    })
    const restored = await read('/admin/settings')
    expect(restored).toEqual({ status: 200, body: new URL(origin).host, port: diagnostic.port })
    await read('/login')
    expect(registered).toBe(1)
    entry.unbind(graph)
    expect((await read('/')).status).toBe(503)
    const next = createServer((_request, response) => {
      response.end('new graph')
    })
    entry.bind(next, () => {
      registered++
    })
    entry.unbind(graph)
    expect((await read('/')).body).toBe('new graph')
    expect(registered).toBe(2)
  } finally {
    agent.destroy()
    await entry.stop()
  }
})

it('cannot publish a listener after stop interrupts its listen handshake', async () => {
  const entry = new StablePublicEntry({ host: '127.0.0.1', port: 0 }, { closed: () => false })
  const starting = entry.start(),
    refused = expect(starting).rejects.toThrow('stopped')
  const stopping = entry.stop()
  try {
    await refused
    await stopping
  } finally {
    await entry.stop()
  }
})

it('closes admitted SSE and WebSocket connections on graph retirement and refuses new work while diagnostic', async () => {
  const entry = new StablePublicEntry({ host: '127.0.0.1', port: 0 }, { closed: () => false }),
    registry = new MemorySessionRegistry()
  const origin = await entry.start(),
    upgrades = new WebSocketServer({ noServer: true })
  let handled = 0
  const graph = createServer((_request, response) => {
    handled++
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.write('data: connected\n\n')
  })
  graph.on('upgrade', (request, socket, head) => {
    upgrades.handleUpgrade(request, socket, head, ws => {
      ws.on('message', () => {
        ws.send(request.headers.cookie ?? '')
      })
    })
  })
  entry.bind(graph, socket => {
    registry.registerConnection(socket, true)
  })
  let request: ReturnType<typeof get> | undefined, ws: WebSocket | undefined
  try {
    const stream = await new Promise<{ closed: Promise<void> }>((resolve, reject) => {
      request = get(origin + '/stream', response => {
        const closed = new Promise<void>(done => {
          response.once('close', done)
        })
        response.on('error', () => {})
        response.once('data', () => {
          resolve({ closed })
        })
        response.resume()
      })
      request.on('error', reject)
    })
    ws = new WebSocket(origin.replace('http:', 'ws:') + '/socket', { headers: { cookie: 'fixture-native-cookie=retained' } })
    await once(ws, 'open')
    const message = once(ws, 'message')
    ws.send('echo')
    expect((await message)[0].toString()).toBe('fixture-native-cookie=retained')
    const closed = once(ws, 'close')
    entry.unbind(graph)
    registry.closeAll()
    await Promise.all([stream.closed, closed])
    expect((await fetch(origin + '/mutation', { method: 'POST', body: 'refused' })).status).toBe(503)
    expect(handled).toBe(1)
    const rejected = new WebSocket(origin.replace('http:', 'ws:') + '/socket')
    rejected.on('error', () => {})
    const status = await new Promise<number>(resolve => {
      rejected.once('unexpected-response', (_request, response) => {
        response.resume()
        resolve(response.statusCode!)
        rejected.terminate()
      })
    })
    expect(status).toBe(503)
  } finally {
    request?.destroy()
    ws?.terminate()
    registry.closeAll()
    await entry.stop()
    await new Promise<void>(resolve => {
      upgrades.close(() => {
        resolve()
      })
    })
  }
})

it('forwards only health probes during maintenance and preserves the bound graph readiness verdict', async () => {
  const entry = new StablePublicEntry({ host: '127.0.0.1', port: 0 }, { closed: () => true })
  const origin = await entry.start()
  let ready = false
  const handled: string[] = []
  const graph = createServer((request, response) => {
    handled.push(request.url!)
    response.writeHead(request.url === '/readyz' && !ready ? 503 : 200)
    response.end('graph')
  })
  try {
    expect((await fetch(origin + '/healthz')).status).toBe(503)
    entry.bind(graph, () => {})
    expect((await fetch(origin + '/healthz')).status).toBe(200)
    expect((await fetch(origin + '/readyz')).status).toBe(503)
    ready = true
    expect((await fetch(origin + '/readyz')).status).toBe(200)
    for (const [path, method] of [
      ['/login', 'GET'],
      ['/readyz', 'POST'],
      ['/healthz/extra', 'GET'],
    ] as const) {
      expect((await fetch(origin + path, { method })).status).toBe(503)
    }
    expect(handled).toEqual(['/healthz', '/readyz', '/readyz'])
    const socket = new WebSocket(origin.replace('http:', 'ws:') + '/healthz')
    socket.on('error', () => {})
    const status = await new Promise<number>(resolve => {
      socket.once('unexpected-response', (_request, response) => {
        response.resume()
        socket.terminate()
        resolve(response.statusCode!)
      })
    })
    expect(status).toBe(503)
  } finally {
    await entry.stop()
  }
})

it('survives an invalid raw HTTP request target before and during maintenance', () => {
  const result = spawnSync(
    process.execPath,
    [
      '--import',
      'tsx',
      '--input-type=module',
      '--eval',
      `
    import { createServer } from 'node:http';
    import { connect } from 'node:net';
    import { StablePublicEntry } from './src/inbound/stable-public-entry.ts';
    let maintenance = false;
    const entry = new StablePublicEntry({host:'127.0.0.1',port:0}, {closed:()=>maintenance});
    const origin = new URL(await entry.start());
    const raw = target => new Promise((resolve,reject) => {
      const socket = connect(Number(origin.port), origin.hostname);
      let data = '';
      socket.setTimeout(2000, () => socket.destroy(Error('HTTP response timed out')));
      socket.on('connect', () => socket.end('GET '+target+' HTTP/1.1\\r\\nHost: '+origin.host+'\\r\\nConnection: close\\r\\n\\r\\n'));
      socket.on('data', chunk => {data += chunk;});
      socket.on('error', reject);
      socket.on('end', () => resolve(Number(data.split(' ')[1])));
    });
    try {
      const statuses = [await raw('//[')];
      entry.bind(createServer((_request,response)=>response.end('ready')), ()=>{});
      statuses.push(await raw('//['));
      maintenance = true;
      statuses.push(await raw('//['));
      statuses.push(await raw('/readyz'));
      console.log(JSON.stringify(statuses));
    } finally {await entry.stop();}
  `,
    ],
    { encoding: 'utf8', timeout: 10000 },
  )
  expect(result.status, result.stderr).toBe(0)
  expect(JSON.parse(result.stdout)).toEqual([503, 400, 400, 200])
})
