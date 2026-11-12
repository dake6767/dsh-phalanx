import { runInNewContext } from 'node:vm'
import { expect, it } from 'vitest'
import { platformPluginClient } from '../src/dsh/community-platform-client.js'

it.each(['shown', 'hidden', 'missing', 'failed', 'disposed'] as const)('registers App Center only when the member setting is shown (%s)', async scenario => {
  const entries: { name: string; id?: string; key?: string }[] = []
  const released: typeof entries = []
  const disposers: (() => void)[] = []
  let respond!: (response: Response) => void
  const settings = new Promise<Response>(resolve => {
    respond = resolve
  })
  let plugin!: { apply(context: object): void }
  const React = { Component: class {}, createElement: () => null }
  runInNewContext(platformPluginClient, {
    window: {
      __ModuleLoader__: {
        load: (value: { factory(require: (name: string) => object): typeof plugin }) => {
          plugin = value.factory(name => (name === 'react' ? React : {}))
        },
      },
    },
    document: { createElement: () => ({ dataset: {}, remove() {} }), head: { appendChild() {} } },
    AbortController,
    fetch: (path: string) => {
      expect(path).toBe('/account/platform-features')
      return settings
    },
    console,
  })
  const context = {
    effect: (run: () => unknown) => {
      const dispose = run()
      if (typeof dispose === 'function') disposers.push(() => dispose())
    },
    inject: (_names: string[], apply: (context: object) => unknown): unknown => apply(context),
    locale: { register: () => () => {}, bind: () => () => '', subscribe: () => () => {}, getSnapshot: () => ({ active: 'en' }) },
    slots: {
      inject: (_name: string, register: () => unknown) => register(),
      register: (entry: (typeof entries)[number]) => {
        entries.push(entry)
        return () => released.push(entry)
      },
    },
  }
  plugin.apply(context)
  if (scenario === 'disposed') for (const dispose of disposers) dispose()
  respond(
    Response.json(scenario === 'missing' ? {} : { showAppCenter: scenario === 'shown' || scenario === 'disposed' }, {
      status: scenario === 'failed' ? 503 : 200,
    }),
  )
  await new Promise(resolve => setImmediate(resolve))
  expect(entries).toContainEqual(expect.objectContaining({ name: 'settings.launcher', priority: -10 }))
  expect(entries.some(entry => entry.name === 'sidebar.footer.action')).toBe(false)
  const appCenter = entries.filter(entry => entry.id === 'phalanx-market' || entry.key === 'phalanx-market')
  expect(appCenter).toEqual(
    scenario === 'shown'
      ? [expect.objectContaining({ name: 'main', key: 'phalanx-market' }), expect.objectContaining({ name: 'sidebar.panellist', id: 'phalanx-market' })]
      : [],
  )
  expect(entries.filter(entry => entry.name.startsWith('plugins.detail.'))).toEqual([])
  if (scenario === 'shown') {
    for (const dispose of disposers) dispose()
    expect(
      released
        .filter(entry => appCenter.includes(entry))
        .map(entry => entry.name)
        .sort(),
    ).toEqual(['main', 'sidebar.panellist'])
  }
})

it.skip('hidden in 0.1.32: opens a plugin contribution draft through the injected navigation context and an existing default workspace', async () => {
  type Element = { props: { onClick?: () => void }; children: Element[] }
  let plugin!: { apply(context: object): void }, action!: (props: object) => Element
  const started: object[] = []
  const React = {
    Component: class {},
    Fragment: 'fragment',
    createElement: (_type: unknown, props: object, ...children: Element[]) => ({ props, children }),
    useState: (initial: unknown) => [initial, () => {}],
    useEffect: () => {},
    useRef: (current: unknown) => ({ current }),
    useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot(),
  }
  runInNewContext(platformPluginClient, {
    window: {
      __ModuleLoader__: {
        load: (value: { factory(require: (name: string) => object): typeof plugin }) => {
          plugin = value.factory(name => (name === 'react' ? React : {}))
        },
      },
    },
    document: { createElement: () => ({ dataset: {}, remove() {} }), head: { appendChild() {} } },
    console,
  })
  const base = {
    effect: (run: () => unknown) => run(),
    locale: { register: () => () => {}, bind: () => () => '', subscribe: () => () => {}, getSnapshot: () => ({ active: 'en' }) },
    slots: {
      inject: (_name: string, register: () => unknown) => register(),
      register: (entry: { name: string }, component: typeof action) => {
        if (entry.name === 'plugins.detail.actions') action = component
        return () => {}
      },
    },
  }
  const context = {
    ...base,
    inject: (names: string[], apply: (context: object) => unknown) =>
      names.includes('uiWorkspace')
        ? apply({
            ...base,
            uiWorkspace: { startSession: (workspace: string, options: object) => started.push({ workspace, options }) },
            workspaces: { list: { getSnapshot: () => ({ items: [{ workspaceId: 'default', sessionIds: [] }] }) } },
            sessions: { list: { getSnapshot: () => ({ byId: {} }) } },
          })
        : undefined,
  }
  for (const name of ['uiWorkspace', 'workspaces', 'sessions'])
    Object.defineProperty(context, name, {
      get: () => {
        throw new Error('Service requires injected context')
      },
    })
  plugin.apply(context)
  const element = action({ subject: { kind: 'bundle', pkg: { name: 'team-plugin', version: '1.0.0', installed: true, official: false } } })
  element.children[0]!.props.onClick!()
  await Promise.resolve()
  expect(started).toEqual([{ workspace: 'default', options: { prompt: expect.stringContaining('team-plugin') } }])
})
