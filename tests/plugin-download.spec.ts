import { request } from 'node:http'
import { createGatewayOnlyServer } from '../src/inbound/public-server.js'
import { expect, it } from 'vitest'
import { createPluginDownload } from '../src/inbound/plugin-download.js'
import { NativePluginDownloads } from '../src/use-cases/native-plugin-downloads.js'
import { SignedPluginDownloadTokens } from '../src/adapters/plugin-download-tokens.js'
import { CommunityModelAuthorization } from '../src/use-cases/community-model-authorization.js'
import { MemorySessionRegistry } from '../src/adapters/memory-session-registry.js'
it('serves only the checked bytes to the same authenticated member before expiry and account revocation', async () => {
  let now = 1000; let published = true; let disabled = false
  const tokens = new SignedPluginDownloadTokens('download-fixture-secret')
  const account = (username: string) => ({ username, spaceId: username, sessionEpoch: 0, admin: false, disabled, email: '', groupId: 'group', createdAt: 0, updatedAt: 0 })
  const prepared = { packageName: 'plugin', version: '1.0.0', integrity: 'sha512-fixture', runtimeRevision: 'revision', artifact: 'fixture', title: '', description: '', bundlePatch: '', dependencies: {} }
  const downloads = new NativePluginDownloads({ get: account }, { list: () => [{ ...prepared, current: prepared, published, stage: 'available' }] }, tokens, { now: () => now }, 'revision')
  const authorization = new CommunityModelAuthorization({ getState: account }, { resolve: token => token === 'alice-token' ? account('alice') : token === 'bob-token' ? account('bob') : undefined })
  let reads = 0
  const connections = new MemorySessionRegistry()
  const handle = createPluginDownload({ downloads, authorization, connections, archives: { open: async () => ({ size: 7, body: (async function* () { reads++; yield Buffer.from('archive') })() }) } })
  let networkCalls = 0
  const server = createGatewayOnlyServer({ connections, pluginDownloads: handle, model: async (_request, response) => { response.writeHead(404).end() }, network: {
    http: async (_request, response) => { networkCalls++; response.writeHead(404).end() },
    connect: async (_request, socket) => { networkCalls++; socket.end('HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n') },
  } })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address(); if (!address || typeof address === 'string') throw Error('not listening')
  const token = tokens.issue({ username: 'alice', spaceId: 'alice', sessionEpoch: 0, packageName: prepared.packageName, integrity: prepared.integrity, artifact: prepared.artifact, expiresAt: 2000 })
  const path = `http://plugins.dsh-phalanx.invalid/plugin-archive/${token}.tgz`
  const get = (credential = 'alice-token', method = 'GET', url = path) => new Promise<{ status: number | undefined, body: string }>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: address.port, path: url, method, headers: { 'proxy-authorization': `Basic ${Buffer.from(`dsh:${credential}`).toString('base64')}` } }, res => {
      let body = ''; res.on('data', chunk => { body += String(chunk) }); res.on('end', () => resolve({ status: res.statusCode, body })); res.on('error', reject)
    }); req.on('error', reject); req.end()
  })
  const tunnel = (credential: string, destination = 'plugins.dsh-phalanx.invalid:80') => new Promise<string>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: address.port, method: 'CONNECT', path: destination, headers: { 'proxy-authorization': `Basic ${Buffer.from(`dsh:${credential}`).toString('base64')}` } })
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
    expect(await tunnel('alice-token', 'plugins.dsh-phalanx.invalid:443')).toBe('403')
    expect((await get('alice-token', 'GET', path.replace('http:', 'https:'))).status).toBe(403)
    expect((await get('alice-token', 'GET', path.replace('.invalid/', '.invalid:bad/'))).status).toBe(403)
    expect(networkCalls).toBe(0)
    expect((await get('alice-token', 'GET', 'http://example.test/')).status).toBe(404)
    expect(networkCalls).toBe(1)
    now = 2000; expect((await get()).status).toBe(403)
    now = 1000; disabled = true; expect((await get()).status).toBe(403)
    disabled = false; published = false; expect((await get()).status).toBe(200)
    expect(reads).toBe(3)
  } finally { connections.closeAll(); await new Promise<void>(resolve => server.close(() => resolve())) }
})
