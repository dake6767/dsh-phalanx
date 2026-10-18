import { createServer } from 'node:http'
import { expect, it } from 'vitest'
import { HttpSuiteCatalogFetch } from '../src/adapters/suite-catalog-fetch.js'

async function serve(handler: (response: import('node:http').ServerResponse) => void): Promise<{ url: string, close(): Promise<void> }> {
  const server = createServer((_request, response) => handler(response))
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('fixture did not listen')
  return { url: `http://127.0.0.1:${address.port}/catalog.json`, close: async () => { await new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()) }) } }
}

it('returns document bytes within the configured limits', async () => {
  const fixture = await serve(response => { response.writeHead(200, { 'content-type': 'application/json' }); response.end('{"format":1}') })
  try { expect(Buffer.from(await new HttpSuiteCatalogFetch().read(fixture.url, new AbortController().signal)).toString('utf8')).toBe('{"format":1}') }
  finally { await fixture.close() }
})

it('reports HTTP failures, oversized bodies and timeouts as unreachable reasons', async () => {
  const failing = await serve(response => { response.writeHead(503); response.end() })
  const large = await serve(response => { response.writeHead(200, { 'content-length': '4096' }); response.end('x'.repeat(4096)) })
  const streamed = await serve(response => { response.writeHead(200); response.end('x'.repeat(4096)) })
  const hanging = await serve(() => { /* never answers */ })
  try {
    await expect(new HttpSuiteCatalogFetch().read(failing.url, new AbortController().signal)).rejects.toThrow('HTTP 503')
    await expect(new HttpSuiteCatalogFetch(10_000, 128).read(large.url, new AbortController().signal)).rejects.toThrow('larger than the platform limit')
    await expect(new HttpSuiteCatalogFetch(10_000, 128).read(streamed.url, new AbortController().signal)).rejects.toThrow('larger than the platform limit')
    await expect(new HttpSuiteCatalogFetch(200).read(hanging.url, new AbortController().signal)).rejects.toThrow('did not answer within')
    await expect(new HttpSuiteCatalogFetch().read('file:///etc/passwd', new AbortController().signal)).rejects.toThrow('HTTP(S)')
  } finally { await Promise.all([failing.close(), large.close(), streamed.close(), hanging.close()]) }
})

it('honors an aborted caller signal', async () => {
  const hanging = await serve(() => {})
  try {
    const controller = new AbortController()
    const pending = new HttpSuiteCatalogFetch().read(hanging.url, controller.signal)
    controller.abort()
    await expect(pending).rejects.toThrow()
  } finally { await hanging.close() }
})
