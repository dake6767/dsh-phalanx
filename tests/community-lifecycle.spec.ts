import { createServer } from 'node:http'
import { expect, it } from 'vitest'
import { CommunityLifecycle } from '../src/composition/community-lifecycle.js'
import type { CommunityRuntimePort } from '../src/ports/community-runtime.js'

it('drains an in-flight account check before closing its storage', async () => {
  let entered!: () => void,
    release!: () => void,
    closed = false,
    calls = 0
  const began = new Promise<void>(resolve => {
    entered = resolve
  })
  const gate = new Promise<void>(resolve => {
    release = resolve
  })
  const runtime = { reconcileStartupContainers: async () => ({}), stopAll: async () => {} } as unknown as CommunityRuntimePort
  const lifecycle = new CommunityLifecycle({
    config: {
      listen: { host: '127.0.0.1', port: 0 },
      runtime: {
        command: process.execPath,
        args: [],
        dataRoot: '/unused',
        defaultModel: { provider: 'deepseek-official', model: 'fixture', upstream: { baseUrl: 'http://localhost' } },
      },
    },
    knownUsers: async () => new Set(),
    runtime,
    connections: { closeAll() {} },
    createListener: () => createServer(),
    checkIntervalMs: 1,
    checkIdle: async () => {
      calls++
      entered()
      await gate
      expect(closed).toBe(false)
    },
    prepareBootstrap: async () => {},
    closeResources: async () => {
      closed = true
    },
  })
  try {
    await lifecycle.start()
    await began
    const stopping = lifecycle.stop()
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(closed).toBe(false)
    expect(calls).toBe(1)
    release()
    await stopping
    expect(closed).toBe(true)
  } finally {
    release()
    await lifecycle.stop()
  }
})

it('does not resume startup after stopping during the known-account lookup', async () => {
  let entered!: () => void,
    release!: () => void,
    reconciliations = 0,
    background = 0
  const began = new Promise<void>(resolve => {
      entered = resolve
    }),
    gate = new Promise<void>(resolve => {
      release = resolve
    })
  const lifecycle = new CommunityLifecycle({
    config: {
      listen: { host: '127.0.0.1', port: 0 },
      runtime: {
        command: process.execPath,
        args: [],
        dataRoot: '/unused',
        defaultModel: { provider: 'deepseek-official', model: 'fixture', upstream: { baseUrl: 'http://localhost' } },
      },
    },
    knownUsers: async () => {
      entered()
      await gate
      return new Set()
    },
    runtime: {
      reconcileStartupContainers: async () => {
        reconciliations++
        return {}
      },
      stopAll: async () => {},
    } as unknown as CommunityRuntimePort,
    connections: { closeAll() {} },
    createListener: () => createServer(),
    prepareBootstrap: async () => {},
    checkIdle: async () => {},
    closeResources: async () => {},
    startBackgroundWork: async () => {
      background++
    },
  })
  const starting = lifecycle.start()
  const refused = expect(starting).rejects.toThrow('stopped during startup')
  await began
  await lifecycle.stop()
  release()
  await refused
  expect(lifecycle.recordsReady()).toBe(false)
  expect(reconciliations).toBe(0)
  expect(background).toBe(0)
})

it('closes all resources after an accepted database activation fails during shutdown', async () => {
  let entered!: () => void,
    release!: () => void,
    shutdownEntered!: () => void,
    closed = false
  const began = new Promise<void>(resolve => {
      entered = resolve
    }),
    gate = new Promise<void>(resolve => {
      release = resolve
    }),
    shuttingDown = new Promise<void>(resolve => {
      shutdownEntered = resolve
    })
  const lifecycle = new CommunityLifecycle({
    config: {
      listen: { host: '127.0.0.1', port: 0 },
      runtime: {
        command: process.execPath,
        args: [],
        dataRoot: '/unused',
        defaultModel: { provider: 'deepseek-official', model: 'fixture', upstream: { baseUrl: 'http://localhost' } },
      },
    },
    prepareEntry: async () => false,
    knownUsers: async () => new Set(),
    connections: { closeAll() {} },
    createListener: () => createServer(),
    checkIdle: async () => {},
    runtime: {
      reconcileStartupContainers: async () => ({}),
      stopAll: async () => {
        shutdownEntered()
      },
    } as unknown as CommunityRuntimePort,
    prepareBootstrap: async () => {
      entered()
      await gate
      throw Error('fixture activation failed')
    },
    closeResources: async () => {
      closed = true
    },
  })
  try {
    await lifecycle.start()
    const activating = lifecycle.activateRecords(),
      refused = expect(activating).rejects.toThrow('fixture activation failed')
    await began
    const stopping = lifecycle.stop()
    await shuttingDown
    release()
    await refused
    await expect(stopping).resolves.toBeUndefined()
    expect(closed).toBe(true)
  } finally {
    release?.()
    await lifecycle.stop()
  }
})

it('never republishes readiness when ownership fails during activation publication', async () => {
  const lifecycle: CommunityLifecycle = new CommunityLifecycle({
    config: {
      listen: { host: '127.0.0.1', port: 0 },
      runtime: {
        command: process.execPath,
        args: [],
        dataRoot: '/unused',
        defaultModel: { provider: 'deepseek-official', model: 'fixture', upstream: { baseUrl: 'http://localhost' } },
      },
    },
    knownUsers: async () => new Set(),
    connections: { closeAll() {} },
    createListener: () => createServer(),
    checkIdle: async () => {},
    runtime: { reconcileStartupContainers: async () => ({}), stopAll: async () => {} } as unknown as CommunityRuntimePort,
    prepareBootstrap: async () => {},
    startBackgroundWork: async () => {
      lifecycle.fail()
    },
    closeResources: async () => {},
  })
  try {
    await expect(lifecycle.start()).rejects.toThrow('stopped during startup')
    expect(lifecycle.recordsReady()).toBe(false)
  } finally {
    await lifecycle.stop()
  }
})

it('releases an accepted database request when startup fails before publishing its entry handshake', async () => {
  let entered!: () => void, release!: () => void
  const began = new Promise<void>(resolve => {
      entered = resolve
    }),
    gate = new Promise<void>(resolve => {
      release = resolve
    })
  const lifecycle = new CommunityLifecycle({
    config: {
      listen: { host: '127.0.0.1', port: 0 },
      runtime: {
        command: process.execPath,
        args: [],
        dataRoot: '/unused',
        defaultModel: { provider: 'deepseek-official', model: 'fixture', upstream: { baseUrl: 'http://localhost' } },
      },
    },
    knownUsers: async () => new Set(),
    connections: { closeAll() {} },
    createListener: () => createServer(),
    checkIdle: async () => {},
    runtime: { reconcileStartupContainers: async () => ({}), stopAll: async () => {} } as unknown as CommunityRuntimePort,
    prepareBootstrap: async () => {},
    startBackgroundWork: async () => {
      entered()
      await gate
      throw Error('fixture startup failed')
    },
    closeResources: async () => {},
  })
  const starting = lifecycle.start(),
    refused = expect(starting).rejects.toThrow('fixture startup failed')
  try {
    await began
    let state = 'pending'
    const request = lifecycle.activateRecords().then(
      () => {
        state = 'accepted'
      },
      () => {
        state = 'refused'
      },
    )
    release()
    await refused
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(state).toBe('refused')
    await request
  } finally {
    release()
    await lifecycle.stop()
  }
})

it('keeps the stable public entry diagnostic until every graph activation step has finished', async () => {
  let entered!: () => void,
    release!: () => void,
    bindings = 0
  const began = new Promise<void>(resolve => {
      entered = resolve
    }),
    gate = new Promise<void>(resolve => {
      release = resolve
    })
  const origin = new URL('http://entry.test')
  const lifecycle = new CommunityLifecycle({
    config: {
      listen: { host: '127.0.0.1', port: 0 },
      runtime: {
        command: process.execPath,
        args: [],
        dataRoot: '/unused',
        defaultModel: { provider: 'deepseek-official', model: 'fixture', upstream: { baseUrl: 'http://localhost' } },
      },
    },
    publicEntry: {
      origin: () => origin,
      bind: () => {
        bindings++
        return origin
      },
      unbind: () => {},
    },
    registerPublicConnection: () => {},
    knownUsers: async () => {
      entered()
      await gate
      return new Set()
    },
    connections: { closeAll() {} },
    createListener: () => createServer(),
    checkIdle: async () => {},
    runtime: { reconcileStartupContainers: async () => ({}), stopAll: async () => {} } as unknown as CommunityRuntimePort,
    prepareBootstrap: async () => {},
    closeResources: async () => {},
  })
  const starting = lifecycle.start()
  try {
    await began
    expect(bindings).toBe(0)
    release()
    await starting
    expect(bindings).toBe(1)
  } finally {
    release()
    await starting
    await lifecycle.stop()
  }
})
