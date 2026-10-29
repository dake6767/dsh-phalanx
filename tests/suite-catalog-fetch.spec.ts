import { createServer } from 'node:http'
import { expect, it } from 'vitest'
import { HttpSuiteCatalogFetch } from '../src/adapters/suite-catalog-fetch.js'

async function serve(handler: (response: import('node:http').ServerResponse) => void): Promise<{ url: string; close(): Promise<void> }> {
  const server = createServer((_request, response) => handler(response))
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('fixture did not listen')
  return {
    url: `http://127.0.0.1:${address.port}/catalog.json`,
    close: async () => {
      await new Promise<void>(resolve => {
        server.closeAllConnections()
        server.close(() => resolve())
      })
    },
  }
}

it('returns document bytes within the configured limits', async () => {
  const fixture = await serve(response => {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end('{"format":1}')
  })
  try {
    expect(Buffer.from(await new HttpSuiteCatalogFetch().read(fixture.url, new AbortController().signal)).toString('utf8')).toBe('{"format":1}')
  } finally {
    await fixture.close()
  }
})

it('reports HTTP failures, oversized bodies and timeouts as unreachable reasons', async () => {
  const failing = await serve(response => {
    response.writeHead(503)
    response.end()
  })
  const large = await serve(response => {
    response.writeHead(200, { 'content-length': '4096' })
    response.end('x'.repeat(4096))
  })
  const streamed = await serve(response => {
    response.writeHead(200)
    response.end('x'.repeat(4096))
  })
  const hanging = await serve(() => {
    /* never answers */
  })
  try {
    await expect(new HttpSuiteCatalogFetch().read(failing.url, new AbortController().signal)).rejects.toThrow('HTTP 503')
    await expect(new HttpSuiteCatalogFetch(10_000, 128).read(large.url, new AbortController().signal)).rejects.toThrow('larger than the platform limit')
    await expect(new HttpSuiteCatalogFetch(10_000, 128).read(streamed.url, new AbortController().signal)).rejects.toThrow('larger than the platform limit')
    await expect(new HttpSuiteCatalogFetch(200).read(hanging.url, new AbortController().signal)).rejects.toThrow('did not answer within')
    await expect(new HttpSuiteCatalogFetch().read('file:///etc/passwd', new AbortController().signal)).rejects.toThrow('HTTP(S)')
  } finally {
    await Promise.all([failing.close(), large.close(), streamed.close(), hanging.close()])
  }
})

it('honors an aborted caller signal', async () => {
  const hanging = await serve(() => {})
  try {
    const controller = new AbortController()
    const pending = new HttpSuiteCatalogFetch().read(hanging.url, controller.signal)
    controller.abort()
    await expect(pending).rejects.toThrow()
  } finally {
    await hanging.close()
  }
})

it('follows at most three HTTP(S) redirects and refuses other schemes', async () => {
  const { createServer } = await import('node:http')
  const server = createServer((request, response) => {
    const path = request.url ?? '/'
    if (path === '/catalog.json') {
      response.writeHead(200)
      response.end('{"format":1}')
      return
    }
    if (path === '/r1') {
      response.writeHead(302, { location: '/r2' })
      response.end()
      return
    }
    if (path === '/r2') {
      response.writeHead(302, { location: '/r3' })
      response.end()
      return
    }
    if (path === '/r3') {
      response.writeHead(302, { location: '/catalog.json' })
      response.end()
      return
    }
    if (path === '/loop1') {
      response.writeHead(302, { location: '/loop2' })
      response.end()
      return
    }
    if (path === '/loop2') {
      response.writeHead(302, { location: '/loop1' })
      response.end()
      return
    }
    if (path === '/to-ftp') {
      response.writeHead(302, { location: 'ftp://example.test/catalog.json' })
      response.end()
      return
    }
    response.writeHead(404)
    response.end()
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const bound = server.address()
  if (!bound || typeof bound === 'string') throw new Error('redirect fixture did not listen')
  const base = `http://127.0.0.1:${bound.port}`
  try {
    expect(Buffer.from(await new HttpSuiteCatalogFetch().read(`${base}/r1`, new AbortController().signal)).toString('utf8')).toBe('{"format":1}')
    await expect(new HttpSuiteCatalogFetch().read(`${base}/loop1`, new AbortController().signal)).rejects.toThrow('too many times')
    await expect(new HttpSuiteCatalogFetch().read(`${base}/to-ftp`, new AbortController().signal)).rejects.toThrow('HTTP(S)')
  } finally {
    await new Promise<void>(resolve => {
      server.closeAllConnections()
      server.close(() => resolve())
    })
  }
})
