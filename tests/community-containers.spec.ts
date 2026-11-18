import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { OwnedCommunityContainers } from '../src/adapters/community-containers.js'
import * as evidence from '../src/adapters/container-write-lock.js'
import { readProfileLock } from '../src/adapters/member-profile-write-lock.js'
import * as command from '../src/adapters/runtime-command.js'
import { dshHomePath, dshProfilesPath, dshWebProfilePath } from '../src/dsh/profile-layout.js'

it.each([
  ['DSH home', dshHomePath, false],
  ['profiles', dshProfilesPath, false],
  ['Web profile', dshWebProfilePath, false],
  ['Web profile with interrupted recovery', dshWebProfilePath, true],
] as const)('reports an invalid %s directory as a profile failure at writer admission', async (_name, profilePath, pending) => {
  const root = await mkdtemp(join(tmpdir(), 'owned-container-profile-admission-'))
  try {
    const home = join(root, 'home')
    const path = profilePath(home)
    await mkdir(path, { mode: 0o700, recursive: true })
    await rm(path, { recursive: true })
    await writeFile(path, 'unusable directory', { mode: 0o600 })
    const recovery = join(root, '.profile-lock-recovery')
    if (pending) await mkdir(recovery, { mode: 0o700 })
    const containers = new OwnedCommunityContainers({ runtime: 'podman', image: 'fixture', internalPort: 4180, gatewayPort: 3081 }, 'root')
    await expect(containers.assertProfileWriterAvailable(home)).rejects.toMatchObject({ code: 'runtime-profile-unavailable' })
    expect(await readFile(path, 'utf8')).toBe('unusable directory')
    if (pending) expect((await lstat(recovery)).isDirectory()).toBe(true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('retains only a space-labelled identity and removes owned carriers without requiring a database during offline cleanup', async () => {
  const root = await mkdtemp(join(tmpdir(), 'owned-container-cli-'))
  const path = join(root, 'state.json'),
    runtime = join(root, 'runtime.mjs')
  const records = [
    {
      Name: 'current',
      State: 'running',
      Id: 'b'.repeat(64),
      Labels: { 'dsh-phalanx.community': '1', 'dsh-phalanx.community-root': 'fixture-root', 'dsh-phalanx.user': 'alice', 'dsh-phalanx.space': 'a'.repeat(32) },
    },
    {
      Name: 'legacy',
      State: 'running',
      Id: 'c'.repeat(64),
      Labels: { 'dsh-phalanx.community': '1', 'dsh-phalanx.community-root': 'fixture-root', 'dsh-phalanx.user': 'alice' },
    },
  ]
  try {
    await writeFile(path, JSON.stringify(records))
    await writeFile(
      runtime,
      `#!/usr/bin/env node
import {readFileSync,writeFileSync} from 'node:fs';
const path=${JSON.stringify(path)}, args=process.argv.slice(2), rows=JSON.parse(readFileSync(path,'utf8'));
if(args[0]==='stop'){
 const row=rows.find(row=>row.Id===args.at(-1));
 if(!row || args[args.indexOf('--time')+1]!=='10')throw Error('Missing verified carrier or shutdown grace');
 row.State='exited';
 writeFileSync(path,JSON.stringify(rows));
}
else if(args[0]==='rm'){
 const row=rows.find(row=>row.Id===args.at(-1));
 if(!row || row.State!=='exited' || args.includes('--force'))throw Error('Remove requires a stopped carrier ID');
 writeFileSync(path,JSON.stringify(rows.filter(candidate=>candidate!==row)));
}
else if(args[0]==='inspect')console.log('observed-current');
else if(args[0]==='ps'){
 const filter=args.find(value=>value.startsWith('name=^'));
 const selected=filter?rows.filter(row=>'name=^'+row.Name+'$'===filter):rows;
 console.log(args.at(-1)==='json'?JSON.stringify(selected):selected.map(row=>row.Name).join('\\n'));
}else throw Error('Unexpected container command');
`,
      { mode: 0o700 },
    )
    const observed: unknown[] = []
    const containers = new OwnedCommunityContainers({ runtime, image: 'fixture', internalPort: 4180, gatewayPort: 3081 }, 'fixture-root')
    expect(
      await containers.rebuild({
        get: async () => {
          throw Error('Unexpected allocation')
        },
        remember: async (owner, hostname) => {
          observed.push({ owner, hostname })
          return hostname
        },
      }),
    ).toEqual(['current', 'legacy'])
    expect(observed).toEqual([{ owner: { username: 'alice', spaceId: 'a'.repeat(32) }, hostname: 'observed-current' }])
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual([])
    await writeFile(path, JSON.stringify(records))
    expect(await containers.rebuild()).toEqual(['current', 'legacy'])
    expect(observed).toHaveLength(1)
    await writeFile(path, JSON.stringify([{ ...records[0], Labels: { ...records[0]!.Labels, 'dsh-phalanx.community-root': 'foreign-root' } }]))
    await expect(containers.rebuild()).rejects.toThrow('ownership')
    expect(JSON.parse(await readFile(path, 'utf8'))).toHaveLength(1)
    await expect(containers.remove('current')).rejects.toThrow('ownership')
    expect(JSON.parse(await readFile(path, 'utf8'))).toHaveLength(1)
    await expect(containers.remove('missing')).resolves.toBeUndefined()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('carries the live writer proof across platform shutdown and rejects a replaced carrier', async () => {
  const root = await mkdtemp(join(tmpdir(), 'owned-container-handoff-'))
  try {
    const home = join(root, 'home')
    const profile = join(home, '.dsh', 'profiles', 'web')
    await mkdir(profile, { mode: 0o700, recursive: true })
    const lock = join(profile, 'package.json.lock')
    await writeFile(lock, '34\n', { mode: 0o600 })
    const original = readProfileLock(home)
    const id = 'b'.repeat(64)
    const row = {
      Name: 'member',
      Id: id,
      State: 'running',
      Labels: { 'dsh-phalanx.community': '1', 'dsh-phalanx.community-root': 'root', 'dsh-phalanx.user': 'alice', 'dsh-phalanx.space': 'a'.repeat(32) },
    }
    let oldPlatformRunning = true
    const stopped: string[] = []
    vi.spyOn(command, 'execFileText').mockImplementation(async (_program, args) => {
      if (args[0] === 'ps') return JSON.stringify([row])
      if (args[0] === 'stop') {
        expect(oldPlatformRunning).toBe(true)
        stopped.push(args.at(-1)!)
        row.State = 'exited'
        return ''
      }
      throw Error('Unexpected container command')
    })
    const proof = { lock: original.identity, home: 'verified', boot: 'current', startedAt: original.bornAt - 10, observed: [id] }
    const mounted = vi.spyOn(evidence, 'liveLegacyProfileWriter').mockImplementation(async () => (oldPlatformRunning ? proof : undefined))
    const exited = vi
      .spyOn(evidence, 'exitedContainerLockEvidence')
      .mockImplementation(async (_runtime, container, _home, observed, _claim, _revision, prior) =>
        container === id && observed.identity === original.identity && prior === proof
          ? { state: 'exited', startedAt: original.bornAt - 10, finishedAt: original.changedAt + 10 }
          : { state: 'unknown' },
      )
    const containers = new OwnedCommunityContainers(
      { runtime: 'podman', image: 'fixture', internalPort: 4180, gatewayPort: 3081 },
      'root',
      10_000,
      async () => home,
    )
    const handoff = await containers.captureLegacyProfileWriters()
    oldPlatformRunning = false
    row.Id = 'c'.repeat(64)
    await containers.recoverLegacyProfileWriters(handoff)
    expect(await readFile(lock, 'utf8')).toBe('34\n')
    expect(stopped).toEqual([])
    row.Id = id
    oldPlatformRunning = true
    await containers.stopPredecessorMembers()
    oldPlatformRunning = false
    await containers.recoverLegacyProfileWriters(handoff)
    expect(stopped).toEqual([id])
    expect(mounted).toHaveBeenCalledTimes(1)
    expect(exited).toHaveBeenCalledTimes(1)
    await expect(readFile(lock)).rejects.toMatchObject({ code: 'ENOENT' })
  } finally {
    vi.restoreAllMocks()
    await rm(root, { recursive: true, force: true })
  }
})
