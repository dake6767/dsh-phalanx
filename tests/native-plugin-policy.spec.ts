import { expect, it } from 'vitest'
import { nativePluginPolicyModule } from '../src/dsh/native-plugin-policy.js'

it('refuses member installs and never-enabled optional bundles while preserving existing bundle operations and native validation', async () => {
  const routes = new Map<string, (request: Request) => Promise<Response>>()
  const calls: string[] = []
  const module = await import(
    'data:text/javascript;base64,' + Buffer.from(nativePluginPolicyModule({ subject: 'member', generation: 'launch', allowInstall: false })).toString('base64')
  )
  module.apply({
    connection: {
      browserPeer: {},
      fetch: { register: (route: { path: string; fetch: (request: Request) => Promise<Response> }) => routes.set(route.path, route.fetch) },
    },
    settings: { describe: () => [{ ns: 'locale', value: { preference: 'zh' } }] },
    typertGateway: {
      invoke: async (input: { method: string }) => {
        calls.push(input.method)
        return input.method === 'listBundles'
          ? [
              { name: 'existing', official: true, optional: true, enabled: false, installed: true },
              { name: 'never', official: true, optional: true, enabled: false, installed: false },
              { name: '@deepseek-ai/dsh-experimental-plugin-market-bundle' },
            ]
          : { application: 'applied' }
      },
    },
  })
  const call = async (method: string, args: object) => {
    const handler = routes.get('/api/pluginManager/' + method)!
    const response = await handler(
      new Request('http://native.example/api/pluginManager/' + method, {
        method: 'POST',
        body: JSON.stringify({ type: 'client-request', rpcId: 'fixture', method: 'pluginManager/' + method, payload: { args } }),
      }),
    )
    return response.json()
  }
  expect(await call('installBundle', { spec: 'fixture-package' })).toMatchObject({
    result: { ok: false, error: { code: 'remote-access/denied', message: '平台已禁用自行添加插件，请联系管理员' } },
  })
  expect(await call('setBundleEnabled', { name: 'never', enabled: true })).toMatchObject({ result: { ok: false, error: { code: 'remote-access/denied' } } })
  expect(await call('setBundleEnabled', { name: 'existing', enabled: true })).toMatchObject({ result: { ok: true } })
  expect(await call('setBundleEnabled', { name: 'never', enabled: false })).toMatchObject({ result: { ok: true } })
  expect((await call('listBundles', {})).result.value).toHaveLength(2)
  expect(calls).not.toContain('installBundle')
  expect(routes.has('/api/phalanx/native-plugins/install')).toBe(false)
})

it('accepts one signed platform installation while refusing cookie-only access and exact replay in the generated member policy', async () => {
  const { NativeInstallAuthority } = await import('../src/adapters/native-install-authority.js')
  const authority = new NativeInstallAuthority()
  const routes = new Map<string, (request: Request) => Promise<Response>>()
  let installations = 0
  const module = await import(
    'data:text/javascript;base64,' +
      Buffer.from(nativePluginPolicyModule({ subject: 'member', generation: 'launch', allowInstall: false, publicKey: authority.publicKey })).toString('base64')
  )
  module.apply({
    connection: {
      browserPeer: {},
      fetch: { register: (route: { path: string; fetch: (request: Request) => Promise<Response> }) => routes.set(route.path, route.fetch) },
    },
    settings: { describe: () => [] },
    typertGateway: {
      invoke: async () => {
        installations++
        return { application: 'applied' }
      },
    },
  })
  const body = JSON.stringify({
    type: 'client-request',
    rpcId: 'fixture',
    method: 'pluginManager/installBundle',
    payload: { args: { spec: '/fixture/plugin.tgz' } },
  })
  const authorization = authority.authorize({ userId: 'member', resourceKey: 'launch' }, body)
  const path = '/api/phalanx/native-plugins/install'
  const call = async (headers: Record<string, string>) =>
    (await routes.get(path)!(new Request('http://native.example' + path, { method: 'POST', headers, body }))).json()
  expect(await call({ cookie: 'native=fixture' })).toMatchObject({ result: { ok: false, error: { code: 'remote-access/denied' } } })
  const headers = { 'x-phalanx-install-proof': authorization.proof, 'x-phalanx-install-signature': authorization.signature }
  expect(await call(headers)).toMatchObject({ result: { ok: true, value: { application: 'applied' } } })
  expect(await call(headers)).toMatchObject({ result: { ok: false, error: { code: 'remote-access/denied', details: { reason: 'platform-install-replay' } } } })
  expect(installations).toBe(1)
})
