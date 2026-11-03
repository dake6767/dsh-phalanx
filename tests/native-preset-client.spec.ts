import { runInNewContext } from 'node:vm'
import { expect, it } from 'vitest'
import { nativePresetClient } from '../src/dsh/native-preset-client.js'

it('replaces Creator cells with browse-only menus while preserving folded view navigation and owner dismissal', () => {
  type Element = { tag: unknown; props: Record<string, unknown>; children: unknown[] }
  type Component = (props: Record<string, unknown>) => Element | null
  const registrations = new Map<string, { id: string; priority: number; component: Component }>()
  const events: string[] = []
  const item = Symbol('Public MenuItemButton')
  let plugin: { apply(ctx: unknown): void } | undefined
  const modules: Record<string, unknown> = {
    react: {
      Fragment: Symbol('Fragment'),
      createElement: (tag: unknown, props: Record<string, unknown>, ...children: unknown[]) => ({ tag, props, children }),
    },
    '@deepseek-ai/dsh-client-ui-primitives': { MenuItemButton: item },
  }
  runInNewContext(nativePresetClient, {
    window: {
      __ModuleLoader__: { load: ({ factory }: { factory(require: (name: string) => unknown): typeof plugin }) => (plugin = factory(name => modules[name])) },
    },
  })
  expect(plugin, 'The public client factory must register the member module').toBeDefined()
  plugin!.apply({
    effect: (effect: () => unknown) => effect(),
    locale: { register: () => () => {} },
    pluginNavigation: { openList: () => events.push('browse') },
    slots: {
      inject: (_name: string, registration: () => unknown) => registration(),
      register: (options: { name: string; id: string; priority: number }, component: Component) => {
        registrations.set(options.name, { ...options, component })
        return () => registrations.delete(options.name)
      },
    },
  })
  const flatten = (value: unknown): Element[] => {
    if (Array.isArray(value)) return value.flatMap(flatten)
    if (!value || typeof value !== 'object' || !('tag' in value)) return []
    const element = value as Element
    return element.tag === item ? [element] : element.children.flatMap(flatten)
  }
  for (const name of ['sidebar.panellist.actions', 'conversation.session.header.views.actions', 'sidebar.right.tab.guide.actions']) {
    const registration = registrations.get(name)!
    expect(registration).toMatchObject({ id: 'entry-customization', priority: -1 })
    const rows = flatten(
      registration.component({
        entries: [{ id: 'folded', label: 'A folded view', active: true }],
        onOpen: (id: string) => events.push('open:' + id),
        onDismiss: () => events.push('dismiss'),
        t: (key: string) => (key === 'browse' ? 'Browse other plugins' : 'Unexpected copy'),
      }),
    )
    expect(rows.map(row => row.children[0])).toEqual(name.startsWith('conversation.') ? ['A folded view', 'Browse other plugins'] : ['Browse other plugins'])
    if (name.startsWith('conversation.')) {
      expect(rows[0]!.props.current).toBe(true)
      ;(rows[0]!.props.onSelect as () => void)()
      expect(events.splice(0)).toEqual(['dismiss', 'open:folded'])
    }
    ;(rows.at(-1)!.props.onSelect as () => void)()
    expect(events.splice(0)).toEqual(['dismiss', 'browse'])
  }
  expect(registrations.get('plugins.add.actions')).toMatchObject({ id: 'create-plugin', priority: -1 })
  expect(registrations.get('plugins.add.actions')!.component({})).toBeNull()
})
