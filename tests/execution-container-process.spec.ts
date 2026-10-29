import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { expect, it, vi } from 'vitest'
import { ContainerExecutionProcess } from '../src/adapters/execution-container-process.js'
import { PlatformContainerOwner } from '../src/adapters/platform-process-host.js'
import { DEFAULT_EXECUTION_LIMITS } from '../src/domain/execution-control.js'
import type { ExecutionLimitsPort } from '../src/ports/execution-control.js'
import type { CommunityRuntimeConfig } from '../src/domain/community-config.js'
import { cleanupOwned } from './fixtures/owned-cleanup.js'

async function fixture(get: ExecutionLimitsPort['get']) {
  const root = await mkdtemp(join(tmpdir(), 'execution-launch-lifetime-'))
  const process = new ContainerExecutionProcess(
    { dataRoot: root, container: { runtime: 'podman', image: 'fixture', internalPort: 1, gatewayPort: 2 } } as CommunityRuntimeConfig,
    { get },
  )
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() })
  child.kill.mockImplementation(() => {
    child.stdout.destroy()
    child.stderr.destroy()
    queueMicrotask(() => child.emit('close', null))
    return true
  })
  child.stdin.once('finish', () => {
    child.stdout.end('{"exit":0}\n')
    child.stderr.end()
    child.emit('close', 0)
  })
  let spawned = false
  const launch = vi.spyOn(process.host, 'launch').mockImplementation(async () => {
    await get()
    spawned = true
    return child as unknown as ChildProcessWithoutNullStreams
  })
  const removal = vi.spyOn(PlatformContainerOwner.prototype, 'requestRemoval').mockResolvedValue()
  const remove = vi.spyOn(PlatformContainerOwner.prototype, 'remove').mockResolvedValue()
  return {
    process,
    child,
    launch,
    removal,
    remove,
    spawned: () => spawned,
    input: { mounts: [], cwd: '/workspace', command: 'tool', argv: [], stdin: new Uint8Array(), environment: {} },
    close: () =>
      cleanupOwned(
        async () => {
          child.kill()
          launch.mockRestore()
          removal.mockRestore()
          remove.mockRestore()
        },
        () => rm(root, { recursive: true, force: true }),
      ),
  }
}

it('finishes every required limits read before a container child exists', async () => {
  let reads = 0
  const get = vi.fn(async () => {
    if (++reads === 2) throw Error('limits unavailable')
    return DEFAULT_EXECUTION_LIMITS
  })
  const value = await fixture(get)
  try {
    await expect(value.process.run(value.input, async () => {}, new AbortController().signal)).rejects.toThrow('limits unavailable')
    expect(get).toHaveBeenCalledTimes(2)
    expect(value.spawned()).toBe(false)
    expect(value.child.stdin.writableFinished).toBe(false)
  } finally {
    await value.close()
  }
})

it('cleans a child launched after cancellation during the host limits read without sending execution input', async () => {
  let reads = 0,
    entered!: () => void,
    release!: () => void
  const began = new Promise<void>(resolve => {
      entered = resolve
    }),
    gate = new Promise<void>(resolve => {
      release = resolve
    })
  const get = async () => {
    if (++reads === 2) {
      entered()
      await gate
    }
    return DEFAULT_EXECUTION_LIMITS
  }
  const value = await fixture(get),
    abort = new AbortController()
  const running = value.process.run(value.input, async () => {}, abort.signal)
  const rejected = expect(running).rejects.toMatchObject({ name: 'AbortError' })
  try {
    await began
    abort.abort()
    release()
    await rejected
    expect(value.spawned()).toBe(true)
    expect(value.child.kill).toHaveBeenCalledWith('SIGKILL')
    expect(value.child.stdin.writableFinished).toBe(false)
    expect(value.remove).toHaveBeenCalledTimes(1)
  } finally {
    release()
    await Promise.allSettled([running])
    await value.close()
  }
})

it('does not perform another fallible limits read after launching the child', async () => {
  const get = vi.fn(async () => {
    if (value.spawned()) throw Error('post-spawn read')
    return DEFAULT_EXECUTION_LIMITS
  })
  const value = await fixture(get)
  try {
    await expect(value.process.run(value.input, async () => {}, new AbortController().signal)).resolves.toBe(0)
    expect(get).toHaveBeenCalledTimes(2)
    expect(value.remove).toHaveBeenCalledTimes(1)
  } finally {
    await value.close()
  }
})
