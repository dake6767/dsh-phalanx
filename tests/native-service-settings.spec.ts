import { expect, it, vi } from 'vitest'
import { nativeServiceSettingsModule } from '../src/dsh/native-service-settings.js'

const binding = {
  kind: 'revisioned-rpc',
  service: 'pluginSettings',
  active: ['settings', 'ai'],
  selection: ['settings', 'ai', 'selection'],
  profiles: ['settings', 'ai', 'profiles'],
  idKey: 'id',
  snapshotKey: 'snap',
  fields: { endpoint: 'url', key: 'key', model: 'model', mode: 'protocol' },
}
const intent = {
  binding,
  id: 'platform-chat',
  fields: { url: 'http://127.0.0.1/relay', key: 'scope-one', model: 'model-a', protocol: 'openai' },
}

async function settingsWorker() {
  const module = 'data:text/javascript;base64,' + Buffer.from(nativeServiceSettingsModule).toString('base64')
  const { syncNativeServiceSettings } = (await import(/* @vite-ignore */ module)) as {
    syncNativeServiceSettings: (
      invoke: (endpoint: string, args: object) => Promise<unknown>,
      input: typeof intent & { previous?: readonly string[] },
    ) => Promise<{ status: string; fingerprint?: string; refresh?: boolean }>
  }
  return syncNativeServiceSettings
}

function service(initial: Record<string, unknown>) {
  let revision = 0,
    data = initial
  const save = vi.fn(async ({ request }: { request: { revision: number; data: Record<string, unknown> } }) => {
    if (request.revision !== revision) throw Error('Revision conflict')
    data = structuredClone(request.data)
    return { revision: ++revision }
  })
  const invoke = (method: string, args: object) => {
    if (method === 'pluginSettings/load') return Promise.resolve({ revision, data: structuredClone(data), secrets: { oauth: 'private' } })
    if (method === 'pluginSettings/save') return save(args as Parameters<typeof save>[0])
    throw Error('Unexpected method')
  }
  return {
    invoke,
    save,
    current: () => data,
    replace: (next: typeof data) => {
      data = next
      revision++
    },
  }
}

it('initializes a new slot through its revisioned RPC and returns only an owned-field fingerprint', async () => {
  const run = await settingsWorker()
  const fixture = service({ workspace: { activeFile: 'personal' }, settings: { extra: 'untouched' } })
  const first = await run(fixture.invoke, intent)
  expect(first).toEqual({ status: 'applied', fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u), refresh: true })
  expect(fixture.current()).toEqual({
    workspace: { activeFile: 'personal' },
    settings: { extra: 'untouched', ai: { ...intent.fields, selection: intent.id, profiles: [{ id: intent.id, snap: intent.fields }] } },
  })
  expect(JSON.stringify(first)).not.toContain('scope-one')
  expect(fixture.save.mock.calls[0]?.[0]).toEqual({ request: { revision: 0, data: fixture.current() } })
  expect(await run(fixture.invoke, { ...intent, previous: [first.fingerprint!] })).toEqual({ ...first, refresh: false })
  expect(fixture.save).toHaveBeenCalledTimes(1)
})

it('rotates a platform profile while preserving personal selection, changes and files', async () => {
  const run = await settingsWorker()
  const fixture = service({})
  const first = await run(fixture.invoke, intent)
  const privateFields = { url: 'https://personal.example', key: 'my-key', model: 'mine', protocol: 'personal' }
  fixture.replace({
    settings: {
      ai: {
        ...privateFields,
        selection: 'personal',
        profiles: [
          { id: intent.id, snap: { ...intent.fields, alias: 'Kept' } },
          { id: 'personal', snap: privateFields },
        ],
      },
    },
    workspace: { activeFile: 'local' },
  })
  const fields = { ...intent.fields, key: 'scope-two' }
  expect(await run(fixture.invoke, { ...intent, fields, previous: [first.fingerprint!] })).toMatchObject({ status: 'applied', refresh: true })
  expect(fixture.current()).toEqual({
    settings: {
      ai: {
        ...privateFields,
        selection: 'personal',
        profiles: [
          { id: intent.id, snap: { ...fields, alias: 'Kept' } },
          { id: 'personal', snap: privateFields },
        ],
      },
    },
    workspace: { activeFile: 'local' },
  })
})

it('preserves changed owned fields and rejects incompatible shape or stale saves', async () => {
  const run = await settingsWorker()
  const fixture = service({})
  const first = await run(fixture.invoke, intent)
  fixture.replace({
    settings: {
      ai: {
        ...intent.fields,
        key: 'changed',
        selection: intent.id,
        profiles: [{ id: intent.id, snap: intent.fields }],
      },
    },
  })
  expect(await run(fixture.invoke, { ...intent, previous: [first.fingerprint!] })).toEqual({ status: 'conflict' })
  fixture.replace({ settings: { ai: { profiles: 'legacy' } } })
  expect(await run(fixture.invoke, intent)).toEqual({ status: 'unsupported' })
  const stale = service({})
  stale.save.mockRejectedValueOnce(Error('Revision conflict or private diagnostic'))
  expect(await run(stale.invoke, intent)).toEqual({ status: 'failed' })
  expect(stale.current()).toEqual({})
  expect(fixture.save).toHaveBeenCalledTimes(1)
})

it('allows the signed empty defaults while retaining an unprofiled personal configuration', async () => {
  const run = await settingsWorker()
  const empty = { url: 'https://public.example/v1', model: 'default', protocol: 'openai' }
  const configured = { ...intent, binding: { ...binding, empty } }
  const blank = service({ settings: { ai: { ...empty, key: '', selection: '', profiles: [] } } })
  const personal = service({ settings: { ai: { ...empty, key: 'personal', selection: '', profiles: [] } } })
  expect(await run(blank.invoke, configured)).toMatchObject({ status: 'applied' })
  expect(await run(personal.invoke, configured)).toEqual({ status: 'conflict' })
  expect(personal.save).not.toHaveBeenCalled()
})

it('retains every personal profile when the signed plugin limit is already reached', async () => {
  const run = await settingsWorker()
  const fixture = service({ settings: { ai: { selection: 'personal', profiles: [{ id: 'personal', snap: { key: 'owned' } }] } } })
  const configured = { ...intent, binding: { ...binding, maxProfiles: 1 } }
  expect(await run(fixture.invoke, configured)).toEqual({ status: 'conflict' })
  expect(fixture.save).not.toHaveBeenCalled()
})
