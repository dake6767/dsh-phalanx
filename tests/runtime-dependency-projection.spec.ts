import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, realpath, readlink, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { FileRuntimeDependencyProjection } from '../src/adapters/runtime-dependency-projection.js'
import type { RuntimeDependencyVersion } from '../src/domain/runtime-dependency.js'
it('atomically switches command links and retains old generations while a member carrier can still use them', async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'dependency-projection-'))
  const version = (digit: string): RuntimeDependencyVersion => ({
    id: digit.repeat(64),
    identity: digit,
    directory: '/host',
    mountedPath: '/fixed/' + digit,
    pathDirectories: ['empty-first', 'bin'],
    commands: ['example'],
    commandPaths: { example: 'bin/example' },
    bytes: 1,
    isolated: true,
    checks: [],
    log: '',
  })
  let versions = [version('a')],
    active = true
  const projection = new FileRuntimeDependencyProjection(
    root,
    async () => versions,
    async () => active,
  )
  try {
    await projection.prepare('member')
    expect(await readlink(join(root, 'member/dependencies/live/example'))).toBe('/fixed/a/bin/example')
    versions = [version('b')]
    await projection.prepare('member')
    expect(await readlink(join(root, 'member/dependencies/live/example'))).toBe('/fixed/b/bin/example')
    expect(await projection.retained()).toEqual(expect.arrayContaining(['a'.repeat(64), 'b'.repeat(64)]))
    versions = []
    await projection.prepare('member')
    expect(await readdir(join(root, 'member/dependencies/live'))).toEqual([])
    expect(await projection.retained()).toHaveLength(2)
    active = false
    expect(await projection.retained()).toEqual([])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('serializes reclamation with publication and member removal, retaining carriers still in use', async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'dependency-projection-race-'))
  const version = (digit: string): RuntimeDependencyVersion => ({
    id: digit.repeat(64),
    identity: digit,
    directory: '/host',
    mountedPath: '/fixed/' + digit,
    pathDirectories: ['bin'],
    commands: ['example'],
    commandPaths: { example: 'bin/example' },
    bytes: 1,
    isolated: true,
    checks: [],
    log: '',
  })
  let versions = [version('a')],
    active = false
  const projection = new FileRuntimeDependencyProjection(
    root,
    async () => versions,
    async () => active,
  )
  let enter!: () => void, release!: () => void
  const entered = new Promise<void>(resolve => {
      enter = resolve
    }),
    gate = new Promise<void>(resolve => {
      release = resolve
    })
  const boundary = projection as unknown as { entries(path: string): Promise<string[]> }
  const original = boundary.entries.bind(projection)
  const spy = vi.spyOn(boundary, 'entries')
  try {
    await projection.prepare('member')
    let paused = false
    spy.mockImplementation(async path => {
      if (path === join(root, 'member/dependencies') && !paused) {
        paused = true
        enter()
        await gate
      }
      return original(path)
    })
    const collect = projection.retained()
    await entered
    versions = [version('b')]
    const publish = projection.prepare('member')
    release()
    await Promise.all([collect, publish])
    expect(await readlink(join(root, 'member/dependencies/live/example'))).toBe('/fixed/b/bin/example')
    expect(await projection.retained()).toEqual(['b'.repeat(64)])
    active = true
    const remove = vi.fn(async () => {
      await rm(join(root, 'member'), { recursive: true, force: true })
    })
    await projection.removeMember('member', remove)
    expect(remove).not.toHaveBeenCalled()
    active = false
    await projection.removeMember('member', remove)
    expect(remove).toHaveBeenCalledOnce()
    expect(await projection.retained()).toEqual([])
  } finally {
    release()
    spy.mockRestore()
    await rm(root, { recursive: true, force: true })
  }
})

it('projects the complete ordered Python library set through an exact venv interpreter while a member venv stays clean', async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'python-projection-'))
  const python = execFileSync('python3', ['-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' }).trim()
  const versions: RuntimeDependencyVersion[] = []
  try {
    for (const [name, digit] of [
      ['z-library', 'b'],
      ['a-library', 'a'],
    ] as const) {
      const directory = join(root, name),
        venv = join(directory, 'venv')
      execFileSync(python, ['-m', 'venv', '--copies', '--without-pip', venv])
      const metadata = JSON.parse(
        execFileSync(
          join(venv, 'bin/python3'),
          ['-c', 'import json,sys,sysconfig; print(json.dumps([sysconfig.get_path("purelib"),sys.implementation.cache_tag]))'],
          { encoding: 'utf8' },
        ),
      ) as [string, string]
      await writeFile(join(metadata[0], digit + '_library.py'), 'value = ' + JSON.stringify(name))
      await writeFile(join(metadata[0], 'ordered_library.py'), 'value = ' + JSON.stringify(name))
      await mkdir(join(metadata[0], 'extras'))
      await writeFile(join(metadata[0], 'extras', digit + '_extra.py'), 'value = True')
      await writeFile(join(metadata[0], 'fixture.pth'), 'extras\n')
      versions.push({
        id: digit.repeat(64),
        identity: digit,
        directory,
        mountedPath: directory,
        pathDirectories: ['venv/bin'],
        commands: ['python3'],
        commandPaths: { python3: 'venv/bin/python3' },
        bytes: 1,
        isolated: false,
        checks: [],
        log: '',
        python: { name, interpreter: 'venv/bin/python3', sitePackages: metadata[0].slice(directory.length + 1), abi: metadata[1] },
      })
    }
    const projection = new FileRuntimeDependencyProjection(join(root, 'members'), async () => versions)
    await projection.prepare('member')
    const command = join(root, 'members/member/dependencies/live/python3')
    const result = JSON.parse(
      execFileSync(
        command,
        [
          '-c',
          'import a_library,b_library,a_extra,b_extra,ordered_library,json,sys; print(json.dumps([a_library.value,b_library.value,ordered_library.value,sys.prefix,sys.base_prefix]))',
        ],
        { encoding: 'utf8', env: { ...process.env, PYTHONPATH: '' } },
      ),
    ) as string[]
    expect(result.slice(0, 3)).toEqual(['a-library', 'z-library', 'a-library'])
    expect(result[3]).toContain('/generation-')
    expect(result[3]).not.toBe(result[4])
    const own = join(root, 'own')
    execFileSync(command, ['-m', 'venv', '--copies', '--without-pip', own])
    execFileSync(
      join(own, 'bin/python3'),
      ['-c', 'import importlib.util; assert importlib.util.find_spec("a_library") is None; assert importlib.util.find_spec("b_library") is None'],
      { env: { ...process.env, PYTHONPATH: '' } },
    )
    expect(await projection.retained()).toEqual(expect.arrayContaining(versions.map(version => version.id)))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('keeps a starting member live generation when another member triggers default synchronization', async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'dependency-starting-'))
  const resource: RuntimeDependencyVersion = {
    id: 'a'.repeat(64),
    identity: 'resource',
    directory: '/host',
    mountedPath: '/fixed/a',
    pathDirectories: [],
    commands: [],
    commandPaths: {},
    bytes: 1,
    isolated: true,
    checks: [],
    log: '',
  }
  let starting = true
  const projection = new FileRuntimeDependencyProjection(
    root,
    async () => [],
    async () => true,
    undefined,
    async () => !starting,
  )
  try {
    await projection.prepare('member', [resource])
    const published = await readlink(join(root, 'member/dependencies/live'))
    await projection.prepare('member')
    expect(await readlink(join(root, 'member/dependencies/live'))).toBe(published)
    expect(await projection.retained()).toEqual([resource.id])
    starting = false
    await projection.prepare('member')
    expect(await readlink(join(root, 'member/dependencies/live'))).not.toBe(published)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
