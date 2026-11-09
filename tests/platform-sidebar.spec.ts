import { runInNewContext } from 'node:vm'
import { expect, it } from 'vitest'
import { platformPluginClient } from '../src/dsh/community-platform-client.js'

it('registers the account and App Center through official slots without a service-preview action', () => {
  const entries: { name: string; id?: string; key?: string }[] = []
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
    console,
  })
  const context = {
    effect: (run: () => unknown) => run(),
    inject: (_names: string[], apply: (context: object) => unknown): unknown => apply(context),
    locale: { register: () => () => {}, bind: () => () => '', subscribe: () => () => {}, getSnapshot: () => ({ active: 'en' }) },
    slots: {
      inject: (_name: string, register: () => unknown) => register(),
      register: (entry: (typeof entries)[number]) => {
        entries.push(entry)
        return () => {}
      },
    },
  }
  plugin.apply(context)
  expect(entries).toContainEqual(expect.objectContaining({ name: 'settings.launcher', priority: -10 }))
  expect(entries.some(entry => entry.name === 'sidebar.footer.action')).toBe(false)
  expect(entries).toContainEqual(expect.objectContaining({ name: 'sidebar.panellist', id: 'phalanx-market' }))
  expect(entries.filter(entry => entry.name.startsWith('plugins.detail.'))).toEqual([])
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
