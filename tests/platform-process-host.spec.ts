import { mkdtemp, mkdir, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { once } from 'node:events'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { PlatformProcessHost } from '../src/adapters/platform-process-host.js'
import { SharedMcpProcess } from '../src/adapters/mcp-shared-process.js'
import { DEFAULT_EXECUTION_LIMITS } from '../src/domain/execution-control.js'
import type { CommunityRuntimeConfig } from '../src/domain/community-config.js'

it.each(['direct', 'symlink'])('refuses a shared carrier dependency rooted in a member space (%s), even in development mode', async kind => {
  const fixtureDirectory = await mkdtemp(join(tmpdir(), 'shared-member-mount-'))
  const root = join(fixtureDirectory, 'data')
  await mkdir(root, { recursive: true })
  const home = join(fixtureDirectory, 'data.durable/users/alice/home')
  await mkdir(home, { recursive: true })
  const directory = kind === 'direct' ? home : join(root, 'dependency-link')
  if (kind === 'symlink') await symlink(home, directory)
  const carrier = new SharedMcpProcess(
    { dataRoot: root } as CommunityRuntimeConfig,
    { isolated: false, containerConfig: undefined },
    { get: async () => DEFAULT_EXECUTION_LIMITS },
  )
  const abort = new AbortController()
  let closed: Promise<number> | undefined
  try {
    const start = carrier
      .start(
        {
          name: 'private',
          description: '',
          url: '',
          generation: 1,
          prepared: { directory },
          run: { location: 'shared', command: 'node', args: ['-e', 'process.stdin.resume()'], env: [], prepareCommand: '' },
        },
        () => {},
        abort.signal,
      )
      .then(handle => {
        closed = handle.closed
        return handle
      })
    await expect(start).rejects.toMatchObject({ code: 'invalid-directory' })
  } finally {
    abort.abort()
    await closed?.catch(() => {})
    await rm(fixtureDirectory, { recursive: true, force: true })
  }
})

it.each(['ancestor', 'ancestor-link', 'member', 'member-link'])('enforces shared mount boundaries at the host launch API (%s)', async kind => {
  const fixtureDirectory = await mkdtemp(join(tmpdir(), 'platform-shared-boundary-'))
  const root = join(fixtureDirectory, 'data')
  await mkdir(root, { recursive: true })
  const home = join(fixtureDirectory, 'data.durable/users/alice/home')
  await mkdir(home, { recursive: true })
  const source = kind.startsWith('ancestor') ? join(fixtureDirectory, 'data.durable') : home
  const directory = kind.endsWith('link') ? join(root, 'dependency-link') : source
  if (kind.endsWith('link')) await symlink(source, directory)
  const host = new PlatformProcessHost({ dataRoot: root } as CommunityRuntimeConfig)
  try {
    await expect(
      host.launch({
        shape: 'shared',
        name: 'boundary',
        cwd: directory,
        dependencies: [{ host: directory, mounted: '/dependency' }],
        nodeArgs: ['-e', 'process.exit(0)'],
      }),
    ).rejects.toMatchObject({ code: 'invalid-directory' })
  } finally {
    await rm(fixtureDirectory, { recursive: true, force: true })
  }
})

it.each(['member', 'symlink', 'extra-mount', 'writable-runner', 'missing-user-root'])(
  'refuses a runtime preparation identity outside its private staging contract (%s)',
  async kind => {
    const fixture = await mkdtemp(join(tmpdir(), 'runtime-preparation-boundary-'))
    const root = join(fixture, 'data'),
      users = join(root, 'members'),
      id = 'a'.repeat(64)
    const privateStage = join(root, 'runtime-dependencies/.trees', id),
      home = join(users, '.trees', id),
      runner = join(root, 'execution/runner')
    await mkdir(home, { recursive: true })
    await mkdir(runner, { recursive: true })
    await mkdir(join(root, 'runtime-dependencies/.trees'), { recursive: true })
    if (kind === 'symlink') await symlink(home, privateStage)
    else await mkdir(privateStage)
    const stage = kind === 'member' ? home : privateStage
    const mounted = '/dsh-phalanx/runtime-dependencies/.trees/' + id
    const userRoot = kind === 'missing-user-root' ? join(root, 'future-users/pending') : users
    if (kind === 'missing-user-root') await symlink(privateStage, join(root, 'future-users'))
    const host = new PlatformProcessHost({ dataRoot: root, userDataRoot: userRoot } as CommunityRuntimeConfig)
    let child: ChildProcessWithoutNullStreams | undefined
    try {
      await expect(
        host
          .launch({
            shape: 'disposable',
            preparation: 'runtime-dependency',
            name: 'boundary',
            cwd: mounted,
            mounts: [
              { host: stage, mounted },
              { host: runner, mounted: '/dsh-phalanx/execution-runner', readOnly: kind !== 'writable-runner' },
              ...(kind === 'extra-mount' ? [{ host: home, mounted: '/member' }] : []),
            ],
            nodeArgs: ['-e', 'process.exit(0)'],
          })
          .then(value => {
            child = value
            return value
          }),
      ).rejects.toMatchObject({ code: 'invalid-directory' })
    } finally {
      if (child && child.exitCode === null) await once(child, 'close')
      await rm(fixture, { recursive: true, force: true })
    }
  },
)
