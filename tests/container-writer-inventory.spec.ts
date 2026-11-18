import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { exitedContainerLockEvidence } from '../src/adapters/container-write-lock.js'
import { profileHomeIdentity, readProfileLock, recoverMemberProfileWriteLock } from '../src/adapters/member-profile-write-lock.js'
import * as runtime from '../src/adapters/runtime-command.js'
import { DSH_CONTAINER_HOME } from '../src/dsh/profile-layout.js'

vi.mock('node:fs', async importOriginal => {
  const fs = await importOriginal<typeof import('node:fs')>()
  return {
    ...fs,
    readFileSync(path: string, ...args: unknown[]) {
      if (path === '/proc/sys/kernel/random/boot_id') return 'fixture-boot\n'
      return Reflect.apply(fs.readFileSync, fs, [path, ...args])
    },
  }
})

it.each([
  { scenario: 'a previously verified disjoint peer disappears', knewPeer: true, disappears: true, recovered: true, inspections: 2 },
  { scenario: 'an unverified peer disappears', knewPeer: false, disappears: true, recovered: false, inspections: 1 },
  { scenario: 'the inventory is unchanged after inspection fails', knewPeer: true, disappears: false, recovered: false, inspections: 1 },
])('revalidates a stopped legacy writer when $scenario', async ({ knewPeer, disappears, recovered, inspections }) => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
  const root = await mkdtemp(join(tmpdir(), 'writer-inventory-'))
  try {
    Object.defineProperty(process, 'platform', { ...platform, value: 'linux' })
    const home = join(root, 'home')
    const profile = join(home, '.dsh', 'profiles', 'web')
    await mkdir(profile, { recursive: true, mode: 0o700 })
    const lockPath = join(profile, 'package.json.lock')
    await writeFile(lockPath, '2147000000\n', { mode: 0o600 })
    const lock = readProfileLock(home)
    const owner = 'a'.repeat(64),
      peer = 'b'.repeat(64)
    const start = Math.floor(lock.bornAt) - 1_000
    const end = Math.ceil(lock.changedAt) + 1_000
    const date = (time: number) => new Date(time).toISOString()
    let listings = 0
    let attempts = 0
    vi.spyOn(runtime, 'execFileText').mockImplementation(async (_command, args) => {
      if (args[0] === 'ps') return ++listings === 1 || !disappears ? owner + '\n' + peer : owner
      if (args[0] === 'inspect') {
        if (++attempts === 1) throw Object.assign(new Error('no such container'), { code: 125 })
        expect(args.slice(-1)).toEqual([owner])
        return JSON.stringify({
          id: owner,
          state: 'exited',
          pid: 0,
          pidMode: 'private',
          started: date(start),
          finished: date(end),
          mounts: [{ Type: 'bind', Source: home, Destination: DSH_CONTAINER_HOME, RW: true }],
        })
      }
      if (args[0] === 'info') return 'file'
      if (args[0] === 'events')
        return [
          { ID: owner, Status: 'start', Time: date(start) },
          { ID: peer, Status: 'remove', Time: date(end) },
        ]
          .map(row => JSON.stringify(row))
          .join('\n')
      throw Error('Unexpected container command')
    })
    const legacy = {
      lock: lock.identity,
      home: profileHomeIdentity(home),
      boot: 'fixture-boot',
      startedAt: start,
      observed: knewPeer ? [owner, peer] : [owner],
    }
    const result = await recoverMemberProfileWriteLock(home, observed =>
      exitedContainerLockEvidence('podman', owner, home, observed, undefined, undefined, legacy),
    )
    expect(attempts).toBe(inspections)
    expect(result).toBe(recovered ? 'recovered' : 'unknown')
    if (recovered) await expect(readFile(lockPath)).rejects.toMatchObject({ code: 'ENOENT' })
    else expect(readProfileLock(home).identity).toBe(lock.identity)
  } finally {
    vi.restoreAllMocks()
    Object.defineProperty(process, 'platform', platform)
    await rm(root, { recursive: true, force: true })
  }
})
