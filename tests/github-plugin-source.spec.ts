import { createServer, type Server } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { HttpGithubPluginSource } from '../src/adapters/github-plugin-source.js'

let server: Server | undefined
afterEach(() => new Promise<void>(resolve => (server ? server.close(() => resolve()) : resolve())))

async function proxy(handler: (url: string) => { status: number; headers?: Record<string, string>; body?: string | Buffer }) {
  server = createServer((request, response) => {
    const reply = handler(request.url ?? '')
    response.writeHead(reply.status, reply.headers)
    response.end(reply.body)
  })
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  return { base, source: new HttpGithubPluginSource({ current: () => ({ githubApi: `${base}/api/`, githubAssets: `${base}/assets/` }) as never }) }
}
const commit = 'c'.repeat(40)
const signal = () => new AbortController().signal

it('follows redirects within the configured scheme and refuses downgrades, missing locations and loops', async () => {
  const { base, source } = await proxy(url => {
    if (url.startsWith('/api/')) return { status: 302, headers: { location: `${base}/listing` } }
    if (url === '/listing') return { status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify([{ sha: commit }]) }
    if (url.includes('/nolocation/')) return { status: 302 }
    if (url.includes('/loop/')) return { status: 302, headers: { location: url } }
    return { status: 404 }
  })
  expect(await source.resolve('owner/repo', signal())).toEqual({ repository: 'owner/repo', commit })
  const directory = await mkdtemp(join(tmpdir(), 'github-source-'))
  try {
    for (const repository of ['owner/nolocation', 'owner/loop'])
      await expect(source.download({ repository, commit }, directory, signal())).rejects.toMatchObject({ code: 'plugin-github-unavailable' })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

it('refuses an http hop when the configured prefix is https', async () => {
  const source = new HttpGithubPluginSource({ current: () => ({ githubApi: 'https://127.0.0.1:1/', githubAssets: '' }) as never })
  // A stubbed fetch answers the https request with an http redirect; that hop must never be requested.
  const original = globalThis.fetch
  const seen: string[] = []
  globalThis.fetch = (async (input: URL | string) => {
    seen.push(String(input))
    return new Response(null, { status: 302, headers: { location: 'http://api.example.test/listing' } })
  }) as typeof fetch
  try {
    await expect(source.resolve('owner/repo', signal())).rejects.toMatchObject({ code: 'plugin-github-unavailable' })
    expect(seen).toEqual(['https://127.0.0.1:1/https://api.github.com/repos/owner/repo/commits?per_page=1'])
  } finally {
    globalThis.fetch = original
  }
})

it('cancels a commit listing that exceeds its byte limit', async () => {
  const { source } = await proxy(() => ({
    status: 200,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify([{ sha: commit }]) + ' '.repeat(5 * 1024 * 1024),
  }))
  await expect(source.resolve('owner/repo', signal())).rejects.toMatchObject({ code: 'plugin-github-unavailable' })
})

it('uses the configured asset prefix and reports a truncated release download as unavailable', async () => {
  const asset = 'https://github.com/owner/repo/releases/download/v1.0.0/package.tgz'
  const { source } = await proxy(url => {
    if (url !== `/assets/${asset}`) return { status: 404 }
    return { status: 200, headers: { 'content-length': '20', connection: 'close' }, body: 'short' }
  })
  const body = await source.releaseAsset(asset, signal())
  const read = async () => {
    const chunks: Uint8Array[] = []
    for await (const chunk of body) chunks.push(chunk)
    return chunks
  }
  await expect(read()).rejects.toMatchObject({ code: 'plugin-github-unavailable' })
})
