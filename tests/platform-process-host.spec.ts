import { mkdtemp, mkdir, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { PlatformProcessHost } from '../src/adapters/platform-process-host.js'
import { SharedMcpProcess } from '../src/adapters/mcp-shared-process.js'
import { DEFAULT_EXECUTION_LIMITS } from '../src/domain/execution-control.js'
import type { CommunityRuntimeConfig } from '../src/domain/community-config.js'

it.each(['direct', 'symlink'])('refuses a shared carrier dependency rooted in a member space (%s), even in development mode', async kind => {
  const root = await mkdtemp(join(tmpdir(), 'shared-member-mount-'))
  const home = join(root, 'users', 'alice', 'home')
  await mkdir(home, { recursive: true })
  const directory = kind === 'direct' ? home : join(root, 'dependency-link')
  if (kind === 'symlink') await symlink(home, directory)
  const carrier = new SharedMcpProcess({ dataRoot: root } as CommunityRuntimeConfig,
    { isolated: false, containerConfig: undefined }, { get: () => DEFAULT_EXECUTION_LIMITS })
  const abort = new AbortController()
  let closed: Promise<number> | undefined
  try {
    const start = carrier.start({ name: 'private', description: '', url: '', generation: 1, prepared: { directory },
      run: { location: 'shared', command: 'node', args: ['-e', 'process.stdin.resume()'], env: [], prepareCommand: '' } }, () => {}, abort.signal)
      .then(handle => { closed = handle.closed; return handle })
    await expect(start).rejects.toMatchObject({ code: 'invalid-directory' })
  } finally { abort.abort(); await closed?.catch(() => {}); await rm(root, { recursive: true, force: true }) }
})

it.each(['ancestor', 'ancestor-link', 'member', 'member-link'])('enforces shared mount boundaries at the host launch API (%s)', async kind => {
  const root = await mkdtemp(join(tmpdir(), 'platform-shared-boundary-'))
  const home = join(root, 'users', 'alice', 'home')
  await mkdir(home, { recursive: true })
  const source = kind.startsWith('ancestor') ? root : home
  const directory = kind.endsWith('link') ? join(root, 'dependency-link') : source
  if (kind.endsWith('link')) await symlink(source, directory)
  const host = new PlatformProcessHost({ dataRoot: root } as CommunityRuntimeConfig)
  try {
    await expect(host.launch({ shape: 'shared', name: 'boundary', cwd: directory,
      dependencies: [{ host: directory, mounted: '/dependency' }], nodeArgs: ['-e', 'process.exit(0)'] })).rejects.toMatchObject({ code: 'invalid-directory' })
  } finally { await rm(root, { recursive: true, force: true }) }
})
