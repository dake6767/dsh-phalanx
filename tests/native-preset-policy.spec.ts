import { expect, it } from 'vitest'
import { nativePresetDefaultModule } from '../src/dsh/native-presets.js'

interface Route {
  readonly path: string
  fetch(request: Request): Promise<Response>
}

async function fixture() {
  let defaultId = 'standard',
    reads = 0
  const routes: Route[] = []
  const plugin = await import('data:text/javascript;base64,' + Buffer.from(nativePresetDefaultModule).toString('base64'))
  plugin.apply({
    connection: { fetch: { register: (route: Route) => routes.push(route) } },
    agentPresets: {
      get defaultId() {
        reads++
        return defaultId
      },
    },
  })
  const route = routes.find(row => row.path === '/api/phalanxNativePresets/default')!
  return {
    select: (id: string) => {
      defaultId = id
    },
    reads: () => reads,
    request: (body: unknown) =>
      route.fetch(
        new Request('http://native.example.test/api/phalanxNativePresets/default', {
          method: 'POST',
          body: JSON.stringify(body),
        }),
      ),
  }
}
const envelope = (args: object = {}) => ({ type: 'client-request', rpcId: 'fixture-default', method: 'phalanxNativePresets/default', payload: { args } })

it('reads the live effective native default without changing member settings', async () => {
  const world = await fixture()
  expect(await (await world.request(envelope())).json()).toEqual({
    type: 'server-response',
    rpcId: 'fixture-default',
    result: { ok: true, value: { defaultId: 'standard' } },
  })
  world.select('phalanx-expert-fixture')
  expect(await (await world.request(envelope())).json()).toMatchObject({ result: { ok: true, value: { defaultId: 'phalanx-expert-fixture' } } })
  expect(world.reads()).toBe(2)
})

it.each([null, { ...envelope(), method: 'pluginManager/installBundle' }, envelope({ name: 'unrelated' }), envelope([])])(
  'rejects malformed or nonempty default requests before accessing the native service (%j)',
  async body => {
    const world = await fixture()
    expect((await world.request(body)).status).toBe(400)
    expect(world.reads()).toBe(0)
  },
)
