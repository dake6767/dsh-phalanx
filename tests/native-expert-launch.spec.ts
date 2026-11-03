import { expect, it, vi } from 'vitest'
import { nativeExpertsTab } from '../src/dsh/community-market-experts-client.js'

function catalog(phase: 'pending' | 'ready', items: { workspaceId: string }[] = []) {
  let state: { phase: 'pending' | 'ready'; items: { workspaceId: string }[]; error: string | null } = { phase, items, error: null }
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    ready: () => {
      state = { ...state, phase: 'ready' }
      for (const listener of [...listeners]) listener()
    },
    fail: () => {
      state = { ...state, error: 'Native catalog unavailable' }
      for (const listener of [...listeners]) listener()
    },
    listeners: () => listeners.size,
  }
}

function fixture() {
  const sessions = catalog('pending'),
    workspaces = catalog('pending', [{ workspaceId: 'workspace' }])
  const controller = new AbortController()
  const services = {
    signal: controller.signal,
    sessions: { list: sessions, create: vi.fn(async () => 'expert-session') },
    workspaces: { list: workspaces, initializeDefault: vi.fn() },
    remote: { session: { selectModel: vi.fn(async () => ({ ok: true })) } },
    layout: { beginNavigation: vi.fn(() => new AbortController().signal) },
    uiWorkspace: { openSession: vi.fn() },
  }
  // Execute the shipped browser module against public native service fakes.
  const launch: (input: typeof services, plan: object, failureText: string) => Promise<void> = new Function(
    'ctx',
    `${nativeExpertsTab}; return launchExpertConversation;`,
  )({ inject: () => {} })
  return { services, sessions, workspaces, controller, launch }
}

it('waits for both native catalogs before publishing a fresh expert blank to startup navigation', async () => {
  const world = fixture()
  const plan = { agentPreset: 'phalanx-expert-commerce', model: { provider: 'shared', model: 'expert-model' } }
  const launched = world.launch(world.services, plan, 'Request failed')
  expect(world.services.sessions.create).not.toHaveBeenCalled()
  world.sessions.ready()
  await Promise.resolve()
  expect(world.services.sessions.create).not.toHaveBeenCalled()
  world.workspaces.ready()
  await launched
  expect(world.services.sessions.create).toHaveBeenCalledExactlyOnceWith({ workspaceId: 'workspace', agentPreset: plan.agentPreset })
  expect(world.services.remote.session.selectModel).toHaveBeenCalledExactlyOnceWith({ sessionId: 'expert-session', ...plan.model })
  expect(world.services.uiWorkspace.openSession).toHaveBeenCalledExactlyOnceWith('expert-session')
  expect(world.sessions.listeners() + world.workspaces.listeners()).toBe(0)
})

it('cancels a launch waiting for native startup when its services are disposed', async () => {
  const world = fixture()
  const launched = world.launch(world.services, { agentPreset: 'expert', model: null }, 'Request failed')
  const failure = expect(launched).rejects.toMatchObject({ name: 'AbortError' })
  world.controller.abort()
  await failure
  world.sessions.ready()
  world.workspaces.ready()
  expect(world.services.sessions.create).not.toHaveBeenCalled()
  expect(world.sessions.listeners() + world.workspaces.listeners()).toBe(0)
})

it('reports unavailable native catalogs and releases both observers without publishing an expert session', async () => {
  const world = fixture()
  const launched = world.launch(world.services, { agentPreset: 'expert', model: null }, 'Request failed')
  const failure = expect(launched).rejects.toMatchObject({ code: 'expert-unavailable' })
  world.workspaces.fail()
  await failure
  expect(world.services.sessions.create).not.toHaveBeenCalled()
  expect(world.sessions.listeners() + world.workspaces.listeners()).toBe(0)
})

it('prevents pending default-workspace restoration from reusing the newly created expert blank', async () => {
  const world = fixture()
  world.sessions.ready()
  world.workspaces.ready()
  const nativeNavigation = new AbortController()
  let initialize!: () => void
  const initialized = new Promise<void>(resolve => {
    initialize = resolve
  })
  let preset = ''
  const restored = initialized.then(() => {
    if (!nativeNavigation.signal.aborted) preset = 'standard'
  })
  world.services.layout.beginNavigation.mockImplementation(() => {
    nativeNavigation.abort()
    return new AbortController().signal
  })
  world.services.sessions.create.mockImplementation(async () => {
    preset = 'expert'
    initialize()
    await restored
    return 'expert-session'
  })
  await world.launch(world.services, { agentPreset: 'expert', model: null }, 'Request failed')
  expect(preset).toBe('expert')
  expect(world.services.uiWorkspace.openSession).toHaveBeenCalledExactlyOnceWith('expert-session')
})
