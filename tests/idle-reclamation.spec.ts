import { describe, expect, it } from 'vitest'
import type { CommunityUserInstance } from '../src/ports/community-runtime.js'
import type { SessionRegistryPort } from '../src/ports/session-registry.js'
import { createIdleReclamation } from '../src/use-cases/idle-reclamation.js'

const instance: CommunityUserInstance = { userId: 'user-a', origin: 'http://127.0.0.1:1', launchUrl: '/', processId: 1 }

function fixture(idleSeconds: number | (() => number | Promise<number>) = 1) {
  let now = 0
  let cookie: string | undefined
  let connected = false
  let idle: number | undefined
  let gateClosed = false
  let probeResults: boolean[] = []
  let activity: number | undefined
  let reclaimCount = 0
  let reclaimedCount = 0
  const events: string[] = []
  const sessions: SessionRegistryPort = {
    registerConnection: () => {},
    track: () => {},
    untrack: () => {},
    closeAll: () => {},
    hasUser: () => connected,
    closeUser: async () => {
      events.push('disconnect')
      connected = false
    },
    rememberRuntimeCookie: (_userId, value) => {
      cookie = value
    },
    runtimeCookie: () => cookie,
    idleSince: () => idle,
    setIdleSince: (_userId, value) => {
      idle = value
    },
    clearIdle: () => {
      idle = undefined
    },
    clearAllIdle: () => {
      idle = undefined
    },
  }
  const reclamation = createIdleReclamation({
    previewActivity: () => activity,
    idleSeconds,
    clock: { now: () => now },
    sessions,
    runtime: {
      status: () => ({ state: 'ready', instance }),
      reclaim: async (_userId, prepare) => {
        reclaimCount += 1
        return (await prepare(instance)) ? 'reclaimed' : 'busy'
      },
    },
    dsh: {
      hasRunningAgent: async () => {
        events.push('probe')
        return probeResults.shift() ?? false
      },
    },
    users: async () => ['user-a'],
    recordsReady: () => true,
    gateClosed: async () => gateClosed,
    origin: () => new URL('http://127.0.0.1:1'),
    onReclaimed: () => {
      reclaimedCount += 1
    },
    onError: error => {
      throw error
    },
  })
  return {
    reclamation,
    sessions,
    events,
    gesture: () => {
      activity = now
    },
    advance: (millis: number) => {
      now += millis
    },
    setGateClosed: (value: boolean) => {
      gateClosed = value
    },
    setConnected: (value: boolean) => {
      connected = value
    },
    setProbeResults: (results: boolean[]) => {
      probeResults = [...results]
    },
    reclaimCount: () => reclaimCount,
    reclaimedCount: () => reclaimedCount,
  }
}

it('defers asynchronous idle settings until records are ready and awaits them during reclamation', async () => {
  let reads = 0
  const f = fixture(async () => {
    reads++
    return 1
  })
  expect(reads).toBe(0)
  expect(f.reclamation.intervalMs).toBe(1000)
  f.sessions.rememberRuntimeCookie('user-a', 'fixture-cookie')
  await f.reclamation.check()
  expect(reads).toBeGreaterThan(0)
  f.advance(2000)
  await f.reclamation.check()
  expect(f.reclaimCount()).toBe(1)
  expect(f.reclaimedCount()).toBe(1)
})

describe('idle reclamation use case', () => {
  it('never reclaims when no runtime cookie can authorize the activity probe', async () => {
    const test = fixture()
    await test.reclamation.check()
    test.advance(2_000)
    await test.reclamation.check()
    expect(test.reclaimCount()).toBe(0)
    expect(test.reclaimedCount()).toBe(0)
    expect(test.events).toEqual([])
  })

  it('clears the idle window while account access is closed', async () => {
    const test = fixture()
    test.sessions.rememberRuntimeCookie('user-a', 'runtime-session')
    await test.reclamation.check()
    test.advance(2_000)
    test.setGateClosed(true)
    await test.reclamation.check()
    expect(test.sessions.idleSince('user-a')).toBeUndefined()
    test.setGateClosed(false)
    await test.reclamation.check()
    test.advance(500)
    await test.reclamation.check()
    expect(test.reclaimCount()).toBe(0)
  })

  it('probes again after disconnect and refuses to reclaim if work becomes active', async () => {
    const test = fixture()
    test.sessions.rememberRuntimeCookie('user-a', 'runtime-session')
    test.setConnected(true)
    await test.reclamation.check()
    test.setConnected(false)
    test.advance(1_500)
    test.setProbeResults([false, true])
    await test.reclamation.check()
    expect(test.events).toEqual(['probe', 'disconnect', 'probe'])
    expect(test.reclaimCount()).toBe(1)
    expect(test.reclaimedCount()).toBe(0)
    expect(test.sessions.idleSince('user-a')).toBeUndefined()

    await test.reclamation.check()
    test.advance(1_500)
    test.setProbeResults([false, false])
    await test.reclamation.check()
    expect(test.reclaimedCount()).toBe(1)
  })
})

it('defers the idle sweep for a trusted preview gesture without keeping an idle preview alive', async () => {
  const test = fixture()
  test.sessions.rememberRuntimeCookie('user-a', 'runtime-session')
  await test.reclamation.check()
  test.advance(900)
  test.gesture()
  test.advance(200)
  await test.reclamation.check()
  expect(test.reclaimCount()).toBe(0)
  test.advance(900)
  await test.reclamation.check()
  expect(test.reclaimedCount()).toBe(1)
})

it('checks carriers every thirty seconds even with idle reclamation disabled', async () => {
  const test = fixture()
  let now = 0,
    checks = 0
  const reclamation = createIdleReclamation({
    idleSeconds: 0,
    clock: { now: () => now },
    sessions: test.sessions,
    runtime: {
      status: () => ({ state: 'ready', instance }),
      reclaim: async () => 'busy',
      refresh: async () => {
        checks++
      },
    },
    dsh: { hasRunningAgent: async () => false },
    users: async () => ['user-a'],
    recordsReady: () => true,
    gateClosed: async () => false,
    origin: () => new URL('http://127.0.0.1'),
    onReclaimed: () => {},
    onError: error => {
      throw error
    },
  })
  await reclamation.check()
  expect(checks).toBe(1)
  now = 29999
  await reclamation.check()
  expect(checks).toBe(1)
  now = 30000
  await reclamation.check()
  expect(checks).toBe(2)
})

it.each([100, 119])('keeps thirty-second health checks when idle seconds %i would otherwise select a non-divisor interval', async idleSeconds => {
  const test = fixture()
  let now = 0
  const checks: number[] = []
  const reclamation = createIdleReclamation({
    idleSeconds,
    clock: { now: () => now },
    sessions: test.sessions,
    runtime: {
      status: () => ({ state: 'ready', instance }),
      reclaim: async () => 'busy',
      refresh: async () => {
        checks.push(now)
      },
    },
    dsh: { hasRunningAgent: async () => false },
    users: async () => ['user-a'],
    recordsReady: () => true,
    gateClosed: async () => false,
    origin: () => new URL('http://127.0.0.1'),
    onReclaimed: () => {},
    onError: error => {
      throw error
    },
  })
  expect(reclamation.intervalMs).toBe(15000)
  for (now = 0; now <= 90000; now += reclamation.intervalMs) await reclamation.check()
  expect(checks).toEqual([0, 30000, 60000, 90000])
})

it('reads changed idle settings and resident flags again across activity awaits, while manual reclaim still works', async () => {
  const test = fixture()
  let now = 0,
    idleSeconds = 1,
    resident = false,
    reclaimed = 0,
    probes = 0,
    health = 0
  let duringProbe = () => {}
  test.sessions.rememberRuntimeCookie('user-a', 'runtime-session')
  const reclamation = createIdleReclamation({
    idleSeconds: () => idleSeconds,
    resident: async () => resident,
    clock: { now: () => now },
    sessions: test.sessions,
    runtime: {
      status: () => ({ state: 'ready', instance }),
      refresh: async () => {
        health++
      },
      reclaim: async (_user, prepare) => {
        if (await prepare(instance)) {
          reclaimed++
          return 'reclaimed'
        }
        return 'busy'
      },
    },
    dsh: {
      hasRunningAgent: async () => {
        probes++
        duringProbe()
        return false
      },
    },
    users: async () => ['user-a'],
    recordsReady: () => true,
    gateClosed: async () => false,
    origin: () => new URL('http://127.0.0.1'),
    onReclaimed: () => {},
    onError: error => {
      throw error
    },
  })
  expect(reclamation.intervalMs).toBe(1000)
  await reclamation.check()
  now = 2000
  duringProbe = () => {
    resident = true
  }
  await reclamation.check()
  expect(reclaimed).toBe(0)
  resident = false
  duringProbe = () => {
    idleSeconds = 0
  }
  await reclamation.check()
  now = 4000
  await reclamation.check()
  expect(reclaimed).toBe(0)
  now = 30000
  await reclamation.check()
  expect(health).toBe(2)
  const before = probes
  duringProbe = () => {}
  resident = true
  expect(await reclamation.prepare('user-a', instance, new URL('http://127.0.0.1'))).toBe(true)
  expect(probes - before).toBe(2)
  resident = false
  idleSeconds = 1
  await reclamation.check()
  now += 2000
  duringProbe = () => {
    idleSeconds = 100
  }
  await reclamation.check()
  expect(reclaimed).toBe(0)
  duringProbe = () => {}
  await reclamation.check()
  now += 101000
  await reclamation.check()
  expect(reclaimed).toBe(1)
})
