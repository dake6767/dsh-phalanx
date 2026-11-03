// Public Client services provide deterministic folded Views for real menu acceptance.
globalThis.window.__ModuleLoader__.load({
  id: '@fixture/native-preset-observer',
  factory: require => {
    const React = require('react')
    return {
      name: 'native-preset-views',
      inject: ['slots', 'uiConversation'],
      apply(ctx) {
        for (let index = 0; index < 8; index++) {
          const id = 'native-preset-probe-' + index
          ctx.effect(() => ctx.uiConversation.views.register({ target: id, create: () => ({ empty: null, replace: () => null, apply: () => null }) }))
          ctx.slots.inject('conversation.view', () =>
            ctx.slots.register({ name: 'conversation.view', id, order: 900 + index, label: () => 'Probe view ' + index }, () =>
              React.createElement('p', null, 'PROBE_VIEW_' + index),
            ),
          )
        }
      },
    }
  },
})
