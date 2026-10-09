import { createServer, request } from 'node:http'
import { expect, it } from 'vitest'
import { createPluginDownload } from '../src/inbound/plugin-download.js'
import { PluginMarket } from '../src/use-cases/plugin-market.js'
import { SignedPluginDownloadTokens } from '../src/adapters/plugin-download-tokens.js'
import { CommunityModelAuthorization } from '../src/use-cases/community-model-authorization.js'
import { MemorySessionRegistry } from '../src/adapters/memory-session-registry.js'
it('serves only the checked bytes to the same authenticated member before expiry and publication revocation', async () => {
  let now = 1000; let published = true; let disabled = false
  const tokens = new SignedPluginDownloadTokens('download-fixture-secret')
  const account = (username: string) => ({ username, spaceId: username, sessionEpoch: 0, admin: false, disabled, email: '', groupId: 'group', createdAt: 0, updatedAt: 0 })
  const prepared = { packageName: 'plugin', version: '1.0.0', integrity: 'sha512-fixture', runtimeRevision: 'revision', artifact: 'fixture', title: '', description: '', bundlePatch: '', dependencies: {} }
  const market = new PluginMarket({ get: account }, { list: () => [{ ...prepared, current: prepared, published, stage: 'available' }], save: () => {} }, { list: async () => [], install: async () => 'applied' }, { ensure: async () => { throw Error('not needed') } }, tokens, { now: () => now }, 'revision')
  const authorization = new CommunityModelAuthorization({ getState: account }, { resolve: token => token === 'alice-token' ? account('alice') : token === 'bob-token' ? account('bob') : undefined })
  let reads = 0
  const handle = createPluginDownload({ market, authorization, connections: new MemorySessionRegistry(), archives: { open: async () => ({ size: 7, body: (async function* () { reads++; yield Buffer.from('archive') })() }) } })
  const server = createServer((req, res) => { void handle.http(req, res).then(handled => { if (!handled) { res.writeHead(404); res.end() } }) })
  server.on('connect', (req, socket, head) => { void handle.connect(req, socket, head).then(handled => { if (!handled) socket.destroy() }) })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address(); if (!address || typeof address === 'string') throw Error('not listening')
  const token = tokens.issue({ username: 'alice', spaceId: 'alice', integrity: prepared.integrity, expiresAt: 2000 })
  const path = `http://plugins.dsh-phalanx.invalid/plugin-archive/${token}.tgz`
  const get = (credential = 'alice-token', method = 'GET', url = path) => new Promise<{ status: number | undefined, body: string }>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: address.port, path: url, method, headers: { 'proxy-authorization': `Basic ${Buffer.from(`dsh:${credential}`).toString('base64')}` } }, res => {
      let body = ''; res.on('data', chunk => { body += String(chunk) }); res.on('end', () => resolve({ status: res.statusCode, body })); res.on('error', reject)
    }); req.on('error', reject); req.end()
  })
  const tunnel = (credential: string) => new Promise<string>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: address.port, method: 'CONNECT', path: 'plugins.dsh-phalanx.invalid:80', headers: { 'proxy-authorization': `Basic ${Buffer.from(`dsh:${credential}`).toString('base64')}` } })
    req.on('error', reject)
    req.on('connect', (res, socket) => {
      if (res.statusCode !== 200) { socket.destroy(); resolve(String(res.statusCode)); return }
      let body = ''; socket.on('data', chunk => { body += String(chunk) }); socket.on('end', () => resolve(body)); socket.on('error', reject)
      // A client cannot change the member identity chosen by CONNECT.
      socket.write(`GET ${new URL(path).pathname} HTTP/1.1\r\nHost: plugins.dsh-phalanx.invalid\r\nProxy-Authorization: Basic ${Buffer.from('dsh:alice-token').toString('base64')}\r\nConnection: close\r\n\r\n`)
    }); req.end()
  })
  try {
    expect(await get()).toEqual({ status: 200, body: 'archive' }); expect(reads).toBe(1)
    expect((await get('alice-token', 'HEAD')).status).toBe(200); expect(reads).toBe(1)
    expect((await get('bob-token')).status).toBe(403)
    expect((await get('unknown')).status).toBe(403)
    expect((await get('alice-token', 'POST')).status).toBe(405)
    expect((await get('alice-token', 'GET', path + '?redirect=example.test')).status).toBe(403)
    expect(await tunnel('alice-token')).toContain('200 OK')
    expect(await tunnel('bob-token')).toContain('403 Forbidden')
    expect(await tunnel('unknown')).toBe('403')
    now = 2000; expect((await get()).status).toBe(403)
    now = 1000; disabled = true; expect((await get()).status).toBe(403)
    disabled = false; published = false; expect((await get()).status).toBe(409)
    expect(reads).toBe(2)
  } finally { await new Promise<void>(resolve => server.close(() => resolve())) }
})
