import { expect, it } from 'vitest'
import { nativeTerminalAccessModule } from '../src/dsh/native-terminal-access.js'

it('denies only valid terminal creation requests with the current native locale and preserves the RPC identity', async () => {
  let route: { path: string; methods: string[]; fetch(request: Request): Promise<Response> } | undefined
  let preference = 'zh'
  const ctx = {
    connection: {
      fetch: {
        register: (value: typeof route) => {
          route = value
        },
      },
    },
    settings: { describe: () => [{ ns: 'locale', value: { preference } }] },
  }
  const module = await import('data:text/javascript;base64,' + Buffer.from(nativeTerminalAccessModule).toString('base64'))
  module.apply(ctx)
  expect(route).toMatchObject({ path: '/api/terminal/create', methods: ['POST'] })
  const request = (body: object, language = 'en-US') =>
    new Request('http://fictional.example.test/api/terminal/create', {
      method: 'POST',
      headers: { 'accept-language': language, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  const body = {
    type: 'client-request',
    rpcId: 'fixture-rpc',
    method: 'terminal/create',
    payload: { args: { agentId: 'session-fixture', request: { id: 'probe', cols: 80, rows: 24 } } },
  }
  const denied = await (await route!.fetch(request(body))).json()
  expect(denied).toMatchObject({
    type: 'server-response',
    rpcId: 'fixture-rpc',
    result: { ok: false, error: { code: 'remote-access/denied', message: '此分组未开放手动终端。Agent 执行命令和平台代执行仍可使用。' } },
  })
  preference = 'en'
  expect(await (await route!.fetch(request(body))).json()).toMatchObject({
    result: { error: { message: 'Manual terminal access is unavailable for this group. Agent commands and platform execution remain available.' } },
  })
  preference = 'auto'
  expect(await (await route!.fetch(request(body, 'en;q=0.2,zh-CN;q=0.9'))).json()).toMatchObject({
    result: { error: { message: expect.stringContaining('此分组') } },
  })
  expect((await route!.fetch(request({ ...body, method: 'shell/execute' }))).status).toBe(400)
})
