import { expect, it } from 'vitest'
import type { CommunityAccountRecord } from '../src/domain/community-account.js'
import { UNLIMITED_INSTANCE_RESOURCES, type InstanceResourceState } from '../src/domain/instance-resources.js'
import type { CommunityRuntimeDriverPort } from '../src/ports/community-runtime-driver.js'
import { CommunityInstanceLifecycle } from '../src/use-cases/community-instance-lifecycle.js'
import { InstanceResources } from '../src/use-cases/instance-resources.js'

function barrier() {
  let release!: () => void, enter!: () => void
  const pending = new Promise<void>(resolve => {
      release = resolve
    }),
    reached = new Promise<void>(resolve => {
      enter = resolve
    })
  return {
    release,
    reached,
    wait: async () => {
      enter()
      await pending
    },
  }
}
function fixture() {
  const admin: CommunityAccountRecord = {
    username: 'admin',
    spaceId: 'a'.repeat(32),
    sessionEpoch: 0,
    admin: true,
    disabled: false,
    groupId: 'admin',
    email: '',
    createdAt: 0,
    updatedAt: 0,
  }
  const actor = { ...admin }
  const member = { ...admin, username: 'member', spaceId: 'b'.repeat(32), admin: false }
  const accounts = [admin, member],
    starts: number[] = [],
    stops: number[] = [],
    updates: number[] = []
  let state: InstanceResourceState = { idleSeconds: 1800, residents: {}, revision: 0, defaults: UNLIMITED_INSTANCE_RESOURCES, overrides: {} }
  const connection = { closeUser: async () => {} }
  const driver: CommunityRuntimeDriverPort = {
    rebuild: async () => [],
    alive: async () => true,
    detach: async () => {},
    start: async userId => {
      const pid = starts.length + 1
      starts.push(pid)
      return {
        userId,
        resourceKey: String(pid),
        processId: pid,
        origin: 'http://localhost',
        launchUrl: 'http://localhost',
        resourceLimits: { limits: state.defaults, swapMiB: state.defaults.memoryMiB === null ? null : 0 },
      }
    },
    stop: async instance => {
      stops.push(instance.processId)
    },
    applyResources: async instance => {
      updates.push(instance.processId)
      return instance.resourceLimits!
    },
  }
  const runtime = new CommunityInstanceLifecycle(driver, async () => ({ url: 'http://localhost', token: 'fictional' }))
  const rows = {
    read: async () => state,
    saveDefaults: async (revision: number, defaults: typeof state.defaults, idleSeconds: number) => {
      if (revision !== state.revision) throw Error('Stale store revision')
      state = { ...state, revision: revision + 1, defaults, idleSeconds }
    },
    saveMember: async () => {
      throw Error('Unexpected member settings write')
    },
  }
  const service = new InstanceResources(
    { get: async username => accounts.find(row => row.username === username), list: async () => accounts },
    { rows, work: { run: async operation => operation({ settings: rows, actors: { lockAdministrator: async () => {} } }) } },
    { read: () => ({ memoryBytes: 4 * 1024 ** 3, cpuCount: 4 }) },
    runtime,
    connection,
    true,
  )
  const prepare = async () => {
    const instance = await runtime.ensure('member', 'http://localhost')
    await service.saveDefaults(admin, { revision: 0, limits: { cpus: 1, memoryMiB: 512, pids: 128 } })
    return instance
  }
  const apply = () =>
    service.apply(
      actor,
      { revision: 1, confirmed: true, targets: [{ username: 'member', spaceId: member.spaceId, instanceKey: '1' }] },
      new URL('http://localhost'),
    )
  return { service, admin, member, driver, connection, runtime, starts, stops, updates, prepare, apply }
}

it.each(['disconnect', 'stop'] as const)('does not restart when authorization changes during %s', async phase => {
  const f = fixture(),
    gate = barrier()
  await f.prepare()
  if (phase === 'disconnect') f.connection.closeUser = gate.wait
  else
    f.driver.stop = async instance => {
      f.stops.push(instance.processId)
      await gate.wait()
    }
  const applying = f.apply(),
    rejected = expect(applying).rejects.toMatchObject({ code: 'sign-in-required' })
  await gate.reached
  Object.assign(f.admin, { sessionEpoch: 1 })
  gate.release()
  await rejected
  expect(f.starts).toEqual([1])
  expect(f.stops).toEqual(phase === 'stop' ? [1] : [])
  await f.runtime.stopAll()
})

it('does not stop the carrier when the target is disabled during disconnection', async () => {
  const f = fixture(),
    gate = barrier()
  await f.prepare()
  f.connection.closeUser = gate.wait
  const applying = f.apply()
  await gate.reached
  Object.assign(f.member, { disabled: true })
  gate.release()
  expect((await applying).results[0]?.status).toBe('failed')
  expect(f.starts).toEqual([1])
  expect(f.stops).toEqual([])
  await f.runtime.stopAll()
})

it('does not update or resurrect an instance whose reclamation already started', async () => {
  const f = fixture(),
    gate = barrier(),
    instance = await f.prepare()
  const reclaiming = f.runtime.reclaim('member', async () => {
    await gate.wait()
    return true
  })
  await gate.reached
  const applying = f.runtime.applyResources(
    instance,
    { cpus: 1, memoryMiB: 512, pids: 128 },
    'http://localhost',
    async () => {},
    async () => {},
  )
  const rejected = expect(applying).rejects.toMatchObject({ reason: 'draining' })
  gate.release()
  await reclaiming
  await rejected
  expect(f.updates).toEqual([])
  expect(f.starts).toEqual([1])
  expect(f.runtime.status('member').state).toBe('stopped')
  await f.runtime.stopAll()
})

it('rechecks authorization after waiting for an existing reclamation that stays busy', async () => {
  const f = fixture(),
    gate = barrier(),
    instance = await f.prepare()
  const reclaiming = f.runtime.reclaim('member', async () => {
    await gate.wait()
    return false
  })
  await gate.reached
  const applying = f.runtime.applyResources(
    instance,
    { cpus: 1, memoryMiB: 512, pids: 128 },
    'http://localhost',
    async () => {},
    async () => {
      await f.service.member({ ...f.admin, sessionEpoch: 0 }, 'member')
    },
  )
  const rejected = expect(applying).rejects.toMatchObject({ code: 'sign-in-required' })
  Object.assign(f.admin, { sessionEpoch: 1 })
  gate.release()
  await reclaiming
  await rejected
  expect(f.updates).toEqual([])
  expect(f.stops).toEqual([])
  expect(f.starts).toEqual([1])
  await f.runtime.stopAll()
})
