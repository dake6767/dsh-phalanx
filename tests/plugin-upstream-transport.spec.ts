import { createServer, type RequestListener } from 'node:http'
import { once } from 'node:events'
import { afterEach, expect, it, vi } from 'vitest'
import { NodePluginUpstreamTransport } from '../src/adapters/plugin-upstream-transport.js'
import type { PluginUpstream } from '../src/domain/plugin-upstream.js'
const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0)) await close() })
async function server(handle: RequestListener) {
  const http = createServer(handle); http.listen(0, '127.0.0.1'); await once(http, 'listening')
  cleanup.push(async () => { http.closeAllConnections(); await new Promise<void>(resolve => http.close(() => resolve())) })
  const address = http.address(); if (!address || typeof address === 'string') throw new Error('missing address')
  return `http://127.0.0.1:${address.port}`
}
it('streams exact request bytes and URL, replaces authority headers, strips cookies and preserves upstream errors', async () => {
  const url = await server(async (req, res) => {
    const body = []; for await (const bytes of req) body.push(bytes)
    res.writeHead(429, { 'content-type': 'application/json', 'set-cookie': 'secret=value', 'x-result': 'yes' })
    res.end(JSON.stringify({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(body).toString('base64') }))
  })
  const upstream: PluginUpstream = { name: 'a', baseUrl: `${url}/api`, credential: 'platform-key', headers: [{ name: 'Authorization', value: 'Bearer {credential}' }, { name: 'X-Tenant-ID', value: '42' }] }
  const response = await new NodePluginUpstreamTransport().send({ upstream, path: '/search%2Fraw?q=a%20b&q=2', method: 'POST',
    headers: { authorization: 'Bearer member-token', cookie: 'bad=1', 'x-api-key': 'member-token', 'proxy-evil': 'bad', 'x-tenant-id': 'forged', connection: 'x-remove', 'x-remove': 'bad', 'content-type': 'application/octet-stream' },
    body: new Blob([new Uint8Array([0, 1, 128, 255])]).stream(), signal: new AbortController().signal })
  expect(response.status).toBe(429); expect(response.headers.has('set-cookie')).toBe(false)
  const result = await response.json()
  expect(result).toMatchObject({ method: 'POST', url: '/api/search%2Fraw?q=a%20b&q=2', body: 'AAGA/w==', headers: { authorization: 'Bearer platform-key', 'x-tenant-id': '42' } })
  for (const name of ['cookie', 'x-api-key', 'proxy-evil', 'x-remove']) expect(result.headers[name]).toBeUndefined()
})
it('does not follow redirects or buffer SSE until completion', async () => {
  let requests = 0
  let finish: (() => void) | undefined
  const url = await server((req, res) => {
    requests++
    if (req.url === '/redirect') { res.writeHead(302, { location: '/destination' }); res.end('redirect'); return }
    res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('data: first\n\n'); finish = () => res.end('data: last\n\n')
  })
  const send = (path: string) => new NodePluginUpstreamTransport().send({ upstream: { name: 'a', baseUrl: url, headers: [], credential: 'key' }, path, method: 'GET', headers: {}, body: new Blob([]).stream(), signal: new AbortController().signal })
  const redirect = await send('/redirect'); expect(redirect.status).toBe(302); expect(await redirect.text()).toBe('redirect'); expect(requests).toBe(1)
  const response = await send('/stream'); const reader = response.body!.getReader()
  expect(new TextDecoder().decode((await reader.read()).value)).toBe('data: first\n\n')
  finish!(); expect(new TextDecoder().decode((await reader.read()).value)).toBe('data: last\n\n'); expect((await reader.read()).done).toBe(true)
})
it('admits exactly 64 MiB and rejects an oversized chunked body', async () => {
  const url = await server(async (req, res) => {
    let bytes = 0
    try { for await (const chunk of req) bytes += chunk.length; res.end(String(bytes)) } catch { res.destroy() }
  })
  const send = (bytes: number) => new NodePluginUpstreamTransport().send({ upstream: { name: 'a', baseUrl: url, headers: [], credential: 'key' }, path: '/', method: 'POST', headers: {},
    body: new ReadableStream({ pull(controller) { if (bytes === 0) { controller.close(); return } const length = Math.min(bytes, 1024 * 1024); bytes -= length; controller.enqueue(new Uint8Array(length)) } }), signal: new AbortController().signal })
  expect(await (await send(64 * 1024 * 1024)).text()).toBe(String(64 * 1024 * 1024))
  await expect(send(64 * 1024 * 1024 + 1)).rejects.toThrow(/64 MiB/u)
})

it('uses a 600 second response-header deadline', async () => {
  let accepted!: () => void
  const ready = new Promise<void>(resolve => { accepted = resolve })
  const url = await server(req => { req.resume(); req.once('end', accepted) })
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  try {
    const sending = new NodePluginUpstreamTransport().send({ upstream: { name: 'a', baseUrl: url, headers: [], credential: 'key' }, path: '/', method: 'GET', headers: {}, body: new Blob([]).stream(), signal: new AbortController().signal })
    let settled = false
    const result = sending.then(() => { settled = true; return undefined }, error => { settled = true; return error as Error })
    await ready
    await vi.advanceTimersByTimeAsync(599_999); expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect((await result)?.message).toMatch(/timed out/u)
  } finally { vi.useRealTimers() }
})
it.each(['GET', 'DELETE', 'OPTIONS'])('forwards unknown-length %s bodies with valid framing', async method => {
  const url = await server(async (req, res) => { let body = ''; for await (const chunk of req) body += chunk; res.end(body) })
  const response = await new NodePluginUpstreamTransport().send({ upstream: { name: 'a', baseUrl: url, headers: [], credential: 'key' }, path: '/', method, headers: { 'transfer-encoding': 'chunked' }, body: new Blob(['stream-body']).stream(), signal: new AbortController().signal })
  expect(response.status).toBe(200); expect(await response.text()).toBe('stream-body')
})
it('connects to an IPv6 loopback upstream', async () => {
  const http = createServer((_req, res) => res.end('ipv6')); http.listen(0, '::1'); await once(http, 'listening')
  cleanup.push(async () => { http.closeAllConnections(); await new Promise<void>(resolve => http.close(() => resolve())) })
  const address = http.address(); if (!address || typeof address === 'string') throw new Error('missing address')
  const response = await new NodePluginUpstreamTransport().send({ upstream: { name: 'a', baseUrl: `http://[::1]:${address.port}`, headers: [], credential: 'key' }, path: '/', method: 'GET', headers: {}, body: new Blob([]).stream(), signal: new AbortController().signal })
  expect(await response.text()).toBe('ipv6')
})
