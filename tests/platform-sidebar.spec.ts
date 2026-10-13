import { runInNewContext } from 'node:vm'
import { expect, it } from 'vitest'
import { platformPluginClient } from '../src/dsh/community-platform-client.js'

it('registers the account and App Center through official slots without a service-preview action', () => {
  const entries: { name: string; id?: string; key?: string }[] = []
  let plugin!: { apply(context: object): void }
  const React = { Component: class {}, createElement: () => null }
  runInNewContext(platformPluginClient, {
    window: { __ModuleLoader__: { load: (value: { factory(require: (name: string) => object): typeof plugin }) => { plugin = value.factory(name => name === 'react' ? React : {}) } } },
    document: { createElement: () => ({ dataset: {}, remove() {} }), head: { appendChild() {} } }, console,
  })
  plugin.apply({ effect: (run: () => unknown) => run(), inject: () => {},
    locale: { register: () => () => {}, bind: () => () => '', subscribe: () => () => {}, getSnapshot: () => ({ active: 'en' }) },
    slots: { inject: (_name: string, register: () => unknown) => register(), register: (entry: typeof entries[number]) => { entries.push(entry); return () => {} } },
  })
  expect(entries.filter(entry => entry.name === 'sidebar.footer.action').map(entry => entry.id)).toEqual(['phalanx-platform-account'])
  expect(entries).toContainEqual(expect.objectContaining({ name: 'sidebar.panellist', id: 'phalanx-market' }))
})
