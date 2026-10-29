import { expect, it } from 'vitest'
import { PluginUpstreamTest } from '../src/use-cases/plugin-upstream-test.js'
import type { PluginUpstream } from '../src/domain/plugin-upstream.js'
const actor = { username: 'admin', spaceId: 'a', sessionEpoch: 0 }
it('uses saved credential and locked headers for a contribution test when write-only fields are blank', async () => {
  const upstream = {
    name: 'test',
    credential: 'fictional-key',
    baseUrl: 'http://localhost',
    headers: [{ name: 'X-Private', value: 'fictional-private-header' }],
    testRequest: { method: 'GET', path: '/' },
  }
  let forwarded: PluginUpstream | undefined
  const tester = new PluginUpstreamTest(
    { list: async () => [], contributionList: async () => [] },
    { list: () => [upstream] },
    {
      send: async input => {
        forwarded = input.upstream
        return new Response('ok')
      },
    },
    { now: () => 0 },
  )
  await tester.preview(actor, 'plugin', { ...upstream, credential: '', headers: [{ name: 'X-Private', value: '' }] })
  expect(forwarded).toEqual(upstream)
})
it('masks fixed locked headers and their JSON encodings from upstream diagnostic responses', async () => {
  const value = 'fictional-"private\\header'
  const tester = new PluginUpstreamTest(
    { list: async () => [] },
    {
      list: () => [
        {
          name: 'test',
          credential: 'fictional-key',
          baseUrl: 'http://localhost',
          headers: [{ name: 'X-Private', value }],
          testRequest: { method: 'GET', path: '/' },
        },
      ],
    },
    { send: async () => new Response(value + ' ' + JSON.stringify(value)) },
    { now: () => 0 },
  )
  const result = await tester.execute(actor, 'plugin', 'test')
  expect(result.body).toBe('●●●● "●●●●"')
})
function fixture(response: () => Response) {
  let credential = 'fictional-secret'
  const requested: unknown[] = []
  let clock = 10
  const tester = new PluginUpstreamTest(
    { list: async () => [] },
    {
      list: () => [
        {
          name: 'search',
          baseUrl: 'http://localhost/api',
          credential,
          headers: [{ name: 'X-API-Key', value: '{credential}' }],
          testRequest: { method: 'POST', path: '/test?q=one', body: { query: 'sample' } },
        } as PluginUpstream,
      ],
    },
    {
      send: async input => {
        requested.push({ ...input, body: await new Response(input.body).text() })
        clock = 35
        return response()
      },
    },
    { now: () => clock },
  )
  return {
    tester,
    requested,
    replace: () => {
      credential = 'replacement-secret'
    },
  }
}
it('uses saved request and current credentials, reports elapsed/status and redacts split secrets', async () => {
  const f = fixture(
    () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('echo fictional-'))
            controller.enqueue(new TextEncoder().encode('secret finished'))
            controller.close()
          },
        }),
        { status: 201 },
      ),
  )
  expect(await f.tester.execute(actor, 'plugin', 'search')).toEqual({ status: 201, elapsedMs: 25, passed: true, body: 'echo ●●●● finished', truncated: false })
  expect(f.requested[0]).toMatchObject({ path: '/test?q=one', method: 'POST', body: '{"query":"sample"}', upstream: { credential: 'fictional-secret' } })
  f.replace()
  await f.tester.execute(actor, 'plugin', 'search')
  expect(f.requested[1]).toMatchObject({ upstream: { credential: 'replacement-secret' } })
})
it('bounds output to 4 KiB and masks credentials that overlap the truncation boundary', async () => {
  const f = fixture(() => new Response('x'.repeat(4090) + 'fictional-secret' + 'y'.repeat(9000), { status: 400 }))
  const result = await f.tester.execute(actor, 'plugin', 'search')
  expect(result.passed).toBe(false)
  expect(result.status).toBe(400)
  expect(result.truncated).toBe(true)
  expect(new TextEncoder().encode(result.body).length).toBeLessThanOrEqual(4096)
  expect(result.body).not.toContain('fictional')
})
it('requires administrator admission before reading secret state', async () => {
  const tester = new PluginUpstreamTest(
    {
      list: async () => {
        throw Error('denied')
      },
    },
    {
      list: () => {
        throw Error('should not read')
      },
    },
    {
      send: async () => {
        throw Error('should not send')
      },
    },
    { now: () => 0 },
  )
  await expect(tester.execute(actor, 'plugin', 'search')).rejects.toThrow('denied')
})
it('never exposes a partial credential from the read-ahead suffix after earlier replacements shrink the text', async () => {
  const f = fixture(() => new Response('xx' + 'fictional-secret'.repeat(300)))
  const result = await f.tester.execute(actor, 'plugin', 'search')
  expect(result.body).toMatch(/^xx(?:●●●●)+$/u)
  expect(result.truncated).toBe(true)
})
it('masks ordinary JSON-escaped credentials including at the visible boundary', async () => {
  const credential = 'fictional-"quoted\\key'
  const escaped = JSON.stringify(credential).slice(1, -1)
  const tester = new PluginUpstreamTest(
    { list: async () => [] },
    { list: () => [{ name: 'test', credential, baseUrl: 'http://localhost', headers: [], testRequest: { method: 'GET', path: '/' } }] },
    { send: async () => new Response('x'.repeat(4088) + escaped.repeat(5)) },
    { now: () => 0 },
  )
  const result = await tester.execute(actor, 'plugin', 'test')
  expect(result.body).not.toContain('fictional')
  expect(result.body).not.toContain('quoted')
  expect(result.truncated).toBe(true)
})

it('masks form-encoded query values and JSON object keys echoed separately from the diagnostic path', async () => {
  const tester = new PluginUpstreamTest(
    { list: async () => [] },
    {
      list: () => [
        {
          name: 'test',
          credential: 'fixture-credential',
          baseUrl: 'http://localhost',
          headers: [],
          testRequest: { method: 'POST', path: '/check?token=old+private+key', body: { 'fictional-object-key-secret': 'ordinary' } },
        },
      ],
    },
    { send: async () => new Response('old+private+key fictional-object-key-secret') },
    { now: () => 0 },
  )
  expect((await tester.execute(actor, 'plugin', 'test')).body).toBe('●●●● ●●●●')
})
