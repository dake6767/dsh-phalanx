import { describe, expect, it } from 'vitest'
import { artifactDownloadHandler, type ArtifactDownloadFiles } from '../src/dsh/community-artifact-download.js'

function fixture() {
  let data: Uint8Array = new Uint8Array([1, 2, 3])
  let version = 'v1'
  let path = '/workspace/中文.bin'
  const reads: number[] = []
  const scope = { sessionId: 'own', workspaceRoot: '/workspace', homeRoot: '/home/member' }
  const stat = () => ({ absolutePath: path, version, bytes: data.length })
  const handler = artifactDownloadHandler({
    scope: async id => id === 'own' ? scope : undefined,
    presented: async (id, seq, index) => id === 'own' && seq === 3 && index === 0 ? '中文.bin' : undefined,
    stat: async () => stat(),
    read: async (_scope, _path, offset, length) => {
      reads.push(length)
      return { ...stat(), offset, data: data.slice(offset, offset + length) }
    },
  })
  const request = (extra = '', method = 'GET') => new Request('http://local/api/phalanx.download?sessionId=own&path=%E4%B8%AD%E6%96%87.bin' + extra, { method })
  return { handler, request, reads, change(value: Uint8Array) { data = value; version += 'x' }, escape() { path = '/private/secret' }, home() { path = '/home/member/report.bin' } }
}

describe('artifact downloads through the authenticated native file seam', () => {
  it('preflights current original bytes and streams an attachment with a Unicode name', async () => {
    const f = fixture()
    const prepared = await f.handler(f.request('', 'POST'))
    expect(prepared.status).toBe(200)
    const meta = await prepared.json() as { version: string }
    const response = await f.handler(f.request('&version=' + meta.version))
    expect(response.headers.get('content-disposition')).toContain("filename*=UTF-8''%E4%B8%AD%E6%96%87.bin")
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]))
    f.change(new Uint8Array([4, 5]))
    expect((await f.handler(f.request('&version=v1'))).status).toBe(409)
    expect(new Uint8Array(await (await f.handler(f.request('&version=v1x'))).arrayBuffer())).toEqual(new Uint8Array([4, 5]))
  })
  it('resolves durable card coordinates and rejects forged sessions, traversal and escaped targets', async () => {
    const f = fixture()
    const card = new Request('http://local/api/phalanx.download?sessionId=own&seq=3&index=0', { method: 'POST' })
    expect((await f.handler(card)).status).toBe(200)
    for (const query of ['sessionId=other&path=a', 'sessionId=own&path=../secret', 'sessionId=own&path=a%5Cb', 'sessionId=own&seq=99&index=0']) {
      expect((await f.handler(new Request('http://local/?' + query, { method: 'POST' }))).status).toBeGreaterThanOrEqual(400)
    }
    f.home()
    expect((await f.handler(f.request('', 'POST'))).status).toBe(200)
    f.escape()
    expect((await f.handler(f.request('', 'POST'))).status).toBe(403)
  })
  it('bounds reads and fails a download when the source changes after admission', async () => {
    const f = fixture()
    f.change(new Uint8Array(4 * 1024 * 1024))
    const response = await f.handler(f.request('&version=v1x'))
    const reader = response.body!.getReader()
    expect((await reader.read()).value!.length).toBeLessThanOrEqual(256 * 1024)
    f.change(new Uint8Array(4 * 1024 * 1024))
    await expect(async () => { while (!(await reader.read()).done) { /* consume */ } }).rejects.toThrow()
    expect(Math.max(...f.reads)).toBeLessThanOrEqual(256 * 1024)
  })
  it('keeps the serialized native route executable and rejects failed or inconsistent reads', async () => {
    const serialized = new Function('return (' + artifactDownloadHandler.toString() + ')')() as typeof artifactDownloadHandler
    let reads = 0
    const source = { absolutePath: '/work/a', version: 'one', bytes: 3 }
    const files: ArtifactDownloadFiles = {
      scope: async () => ({ sessionId: 'own', workspaceRoot: '/work' }),
      presented: async () => undefined,
      stat: async () => ({ ...source }),
      read: async () => { reads++; source.version = 'two'; return { ...source, offset: 0, data: new Uint8Array(3) } },
    }
    const handler = serialized(files)
    const request = () => new Request('http://local/?sessionId=own&path=a&version=one')
    const response = await handler(request())
    expect(response.status).toBe(409)
    expect(reads).toBe(1)
    const denied = serialized({ ...files, stat: async () => { throw new Error('Access denied') } })
    const error = await denied(request())
    expect(error.status).toBe(403); expect(error.headers.get('content-disposition')).toBeNull()
    const controller = new AbortController(); controller.abort()
    expect((await handler(new Request(request(), { signal: controller.signal }))).status).toBe(403)
  })

})
