import { execFileSync } from 'node:child_process'
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it, vi } from 'vitest'
import { ContainerExecutionProcess } from '../src/adapters/execution-container-process.js'
import { ContainerExecutionRunner } from '../src/adapters/execution-runner.js'
import { removeCommunityFixture } from './fixtures/owned-cleanup.js'
import { createCommunityApplication } from './support/community-application.js'

it('loads a declared Node library from a separate prepared tree while running the skill script', async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'execution-node-modules-'))
  const home = join(root, 'home'),
    workspace = join(root, 'workspace'),
    source = join(root, 'source'),
    library = join(root, 'library')
  for (const directory of [home, workspace, source, join(library, 'node_modules/phalanx-runtime-fixture-module')]) await mkdir(directory, { recursive: true })
  await writeFile(join(library, 'node_modules/phalanx-runtime-fixture-module/index.js'), 'module.exports = "NODE_LIBRARY_OK"')
  await writeFile(join(source, 'main.cjs'), 'console.log(require("phalanx-runtime-fixture-module"))')
  const runtime = {
    dataRoot: root,
    command: 'node',
    args: [],
    defaultModel: { provider: 'deepseek-official', model: 'fixture', upstream: { baseUrl: 'https://example.test' } },
  }
  const process = new ContainerExecutionProcess(runtime)
  const detection = vi.spyOn(process.host, 'detect').mockResolvedValue()
  const runner = new ContainerExecutionRunner(
    runtime,
    { async assertAvailable() {}, prepare: async () => ({ home, workspace, spaceId: 'member-space' }) },
    { directory: () => source },
    process,
  )
  try {
    await runner.recover()
    let output = ''
    const code = await runner.run(
      {
        username: 'member',
        owner: 'skill:node',
        version: 'source',
        cwd: workspace,
        command: './main.cjs',
        argv: [],
        stdin: new Uint8Array(),
        environment: { NODE_PATH: '/untrusted-member-modules' },
        dependencies: [
          {
            id: 'a'.repeat(64),
            identity: 'node-library',
            directory: library,
            mountedPath: library,
            pathDirectories: [],
            commands: [],
            commandPaths: {},
            bytes: 1,
            isolated: false,
            checks: [],
            log: '',
          },
        ],
      },
      async event => {
        output += new TextDecoder().decode(event.data)
      },
      new AbortController().signal,
    )
    expect(code, output).toBe(0)
    expect(output).toContain('NODE_LIBRARY_OK')
  } finally {
    try {
      await runner.stop()
    } finally {
      detection.mockRestore()
      await removeCommunityFixture(root)
    }
  }
})

it.each(['request', 'shutdown'])('cleans late container creation and blocked output on %s cancellation', async cancellation => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'execution-cancellation-'))
  const cli = join(root, 'container-cli.mjs'),
    home = join(root, 'home'),
    workspace = join(root, 'workspace')
  await copyFile(fileURLToPath(new URL('./fixtures/execution-cli.mjs', import.meta.url)), cli)
  await chmod(cli, 0o700)
  await mkdir(home)
  await mkdir(workspace)
  const runner = new ContainerExecutionRunner(
    {
      dataRoot: root,
      command: 'node',
      args: [],
      defaultModel: { provider: 'deepseek-official', model: 'fixture', upstream: { baseUrl: 'https://example.test' } },
      container: { runtime: cli, image: 'fixture', internalPort: 4180, gatewayPort: 4181 },
    },
    { async assertAvailable() {}, prepare: async () => ({ home, workspace, spaceId: 'member-space' }) },
    { directory: () => root },
  )
  const controller = new AbortController()
  let ready!: () => void
  const emitting = new Promise<void>(resolve => {
    ready = resolve
  })
  try {
    const running = runner.run(
      {
        username: 'member',
        owner: 'skill:news',
        version: 'version',
        command: 'news-cli',
        argv: [],
        cwd: '/dsh-phalanx/workspace',
        stdin: new Uint8Array(),
        environment: {},
      },
      async event => {
        expect(new TextDecoder().decode(event.data)).toBe('ready-to-cancel')
        ready()
        if (cancellation === 'request') controller.abort()
        else await new Promise<void>(() => {})
      },
      controller.signal,
    )
    const rejected = expect(running).rejects.toBeDefined()
    await emitting
    if (cancellation === 'shutdown') await runner.stop()
    await rejected
    expect(await readFile(join(root, 'creation-finished'), 'utf8')).toBe('yes')
    await expect(readFile(join(root, 'container'))).rejects.toMatchObject({ code: 'ENOENT' })
    await runner.stop()
  } finally {
    await removeCommunityFixture(root)
  }
})

it('executes Python scripts and shell python3 with only their declared library versions', async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'execution-python-')),
    home = join(root, 'home'),
    workspace = join(root, 'workspace')
  const python = execFileSync('python3', ['-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' }).trim()
  await mkdir(home)
  await mkdir(workspace)
  const runtime = {
    dataRoot: root,
    command: 'node',
    args: [],
    defaultModel: { provider: 'deepseek-official', model: 'fixture', upstream: { baseUrl: 'https://example.test' } },
  }
  const process = new ContainerExecutionProcess(runtime)
  // This case executes host-created venvs; an installed podman CLI must not select a container image.
  const detection = vi.spyOn(process.host, 'detect').mockResolvedValue()
  const runner = new ContainerExecutionRunner(
    runtime,
    { async assertAvailable() {}, prepare: async () => ({ home, workspace, spaceId: 'member-space' }) },
    { directory: () => root },
    process,
  )
  try {
    const dependencies: import('../src/domain/runtime-dependency.js').RuntimeDependencyVersion[] = []
    for (const name of ['a', 'b']) {
      const directory = join(root, name),
        venv = join(directory, 'venv')
      execFileSync(python, ['-m', 'venv', '--copies', '--without-pip', venv])
      const [site, abi] = JSON.parse(
        execFileSync(
          join(venv, 'bin/python3'),
          ['-c', 'import sys,sysconfig,json; print(json.dumps([sysconfig.get_path("purelib"),sys.implementation.cache_tag]))'],
          { encoding: 'utf8' },
        ),
      ) as [string, string]
      await writeFile(join(site, name + '_library.py'), 'value = True')
      dependencies.push({
        id: name.repeat(64),
        identity: name,
        directory,
        mountedPath: directory,
        pathDirectories: ['venv/bin'],
        commands: ['python3'],
        commandPaths: { python3: 'venv/bin/python3' },
        bytes: 1,
        isolated: false,
        checks: [],
        log: '',
        python: { name, interpreter: 'venv/bin/python3', sitePackages: site.slice(directory.length + 1), abi },
      })
    }
    await writeFile(join(root, 'sample.py'), 'import a_library,b_library; print("both-libraries")')
    await runner.recover()
    const request = { username: 'member', owner: 'skill:python', version: 'version', cwd: workspace, stdin: new Uint8Array(), environment: {}, dependencies }
    let output = ''
    const emit = async (event: import('../src/domain/platform-execution.js').ExecutionEvent) => {
      output += new TextDecoder().decode(event.data)
    }
    expect(await runner.run({ ...request, command: './sample.py', argv: [] }, emit, new AbortController().signal)).toBe(0)
    expect(output).toContain('both-libraries')
    expect(await runner.run({ ...request, command: 'sh', argv: ['-c', 'python3 -c "import a_library,b_library"'] }, emit, new AbortController().signal)).toBe(0)
    expect(
      await runner.run(
        {
          ...request,
          dependencies: dependencies.slice(0, 1),
          command: 'python3',
          argv: ['-c', 'import a_library,importlib.util; assert importlib.util.find_spec("b_library") is None'],
        },
        emit,
        new AbortController().signal,
      ),
    ).toBe(0)
    await runner.stop()
  } finally {
    try {
      await runner.stop()
    } finally {
      detection.mockRestore()
      await removeCommunityFixture(root)
    }
  }
})

it('retains the Python environment after failed container cleanup until recovery confirms termination', async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'execution-python-retention-')),
    home = join(root, 'home'),
    workspace = join(root, 'workspace'),
    directory = join(root, 'library')
  await mkdir(home)
  await mkdir(workspace)
  await mkdir(join(directory, 'venv/bin'), { recursive: true })
  await writeFile(join(directory, 'venv/bin/python3'), 'prepared interpreter', { mode: 0o555 })
  await writeFile(join(directory, 'venv/pyvenv.cfg'), 'include-system-site-packages = false\n')
  const runtime = {
    dataRoot: root,
    command: 'node',
    args: [],
    defaultModel: { provider: 'deepseek-official', model: 'fixture', upstream: { baseUrl: 'https://example.test' } },
  }
  const process = new ContainerExecutionProcess(runtime)
  let discard = false
  vi.spyOn(process, 'canDiscardArtifacts', 'get').mockImplementation(() => discard)
  vi.spyOn(process, 'run').mockRejectedValue(new Error('container cleanup failed'))
  const recover = vi.spyOn(process, 'recover').mockRejectedValue(new Error('container still running'))
  const runner = new ContainerExecutionRunner(
    runtime,
    { async assertAvailable() {}, prepare: async () => ({ home, workspace, spaceId: 'member-space' }) },
    { directory: () => root },
    process,
  )
  const trees = join(root, 'execution/python-libraries')
  try {
    await expect(
      runner.run(
        {
          username: 'member',
          owner: 'skill:python',
          version: 'version',
          command: 'python3',
          argv: [],
          cwd: workspace,
          stdin: new Uint8Array(),
          environment: {},
          dependencies: [
            {
              id: 'a'.repeat(64),
              identity: 'a',
              directory,
              mountedPath: directory,
              pathDirectories: ['venv/bin'],
              commands: ['python3'],
              commandPaths: { python3: 'venv/bin/python3' },
              bytes: 1,
              isolated: false,
              checks: [],
              log: '',
              python: { name: 'library', interpreter: 'venv/bin/python3', sitePackages: 'venv/lib/python3.11/site-packages', abi: 'cpython-311' },
            },
          ],
        },
        async () => {},
        new AbortController().signal,
      ),
    ).rejects.toThrow('container cleanup failed')
    const retained = await readdir(trees)
    expect(retained).toHaveLength(1)
    expect(await readFile(join(trees, retained[0]!, '.python/bin/python3'), 'utf8')).toBe('prepared interpreter')
    await expect(runner.recover()).rejects.toThrow('container still running')
    expect(await readdir(trees)).toEqual(retained)
    recover.mockImplementation(async () => {
      discard = true
    })
    await runner.recover()
    expect(await readdir(trees)).toEqual([])
  } finally {
    vi.restoreAllMocks()
    await removeCommunityFixture(root)
  }
})

it('reclaims orphaned Python call environments during application startup after container recovery', async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'execution-python-restart-'))
  const create = () =>
    createCommunityApplication({
      listen: { host: '127.0.0.1', port: 0 },
      sessionSecret: 'python-restart-fixture-session-secret',
      runtime: {
        dataRoot: root,
        command: '/unavailable',
        args: [],
        defaultModel: { provider: 'deepseek-official', model: 'fixture', upstream: { baseUrl: 'https://example.test' } },
      },
    })
  let app = create()
  try {
    await app.start()
    await app.stop()
    const trees = join(root, 'execution/python-libraries')
    await mkdir(join(trees, 'run-Ab12Cd'), { recursive: true })
    await mkdir(join(trees, 'unrelated'))
    app = create()
    await app.start()
    expect(await readdir(trees)).toEqual(['unrelated'])
  } finally {
    await app.stop()
    await removeCommunityFixture(root)
  }
})

it.each([false, true])('keeps private Python variables out of native child environments with shebang=%s', async shebang => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'execution-private-python-')),
    home = join(root, 'home'),
    workspace = join(root, 'workspace')
  await mkdir(home)
  await mkdir(workspace)
  const runner = new ContainerExecutionRunner(
    {
      dataRoot: root,
      command: 'node',
      args: [],
      defaultModel: { provider: 'deepseek-official', model: 'fixture', upstream: { baseUrl: 'https://example.test' } },
    },
    { async assertAvailable() {}, prepare: async () => ({ home, workspace, spaceId: 'member-space' }) },
    { directory: () => root },
  )
  try {
    await writeFile(join(workspace, 'json.py'), 'raise RuntimeError("member module executed")')
    await writeFile(join(workspace, 'sitecustomize.py'), 'raise RuntimeError("member startup executed")')
    await writeFile(join(root, 'trusted_neighbor.py'), 'value = "trusted"')
    await writeFile(
      join(root, 'private.py'),
      (shebang ? '#!/usr/bin/env python3\n' : '') +
        `import os,sys,subprocess,json,trusted_neighbor
assert os.getenv('PRIVATE_KEY')
assert trusted_neighbor.value == 'trusted'
assert sys.argv[1:] == ['literal argument']
assert sys.stdin.buffer.read() == b'input\\x00bytes'
subprocess.run([sys.executable,'-I','-c',"import os; assert not os.getenv('PRIVATE_KEY')"],check=True)
for copied in [os.environ.copy(),dict(os.environ)]:
    subprocess.run([sys.executable,'-I','-c',"import os; assert not os.getenv('PRIVATE_KEY')"],check=True,env=copied)
from pathlib import Path
proc=Path('/proc/self/environ')
if proc.exists(): assert os.getenv('PRIVATE_KEY').encode() not in proc.read_bytes()
Path('result.txt').write_text('PRIVATE_PYTHON_OK')
print('PRIVATE_PYTHON_OK')
`,
    )
    await chmod(join(root, 'private.py'), 0o700)
    let output = ''
    expect(
      await runner.run(
        {
          username: 'member',
          owner: 'skill:python',
          version: 'version',
          command: './private.py',
          argv: ['literal argument'],
          cwd: workspace,
          stdin: new TextEncoder().encode('input\0bytes'),
          environment: { PRIVATE_KEY: 'platform-only-fixture-value' },
        },
        async event => {
          output += new TextDecoder().decode(event.data)
        },
        new AbortController().signal,
      ),
      output,
    ).toBe(0)
    expect(output).toContain('PRIVATE_PYTHON_OK')
    expect(output).not.toContain('platform-only-fixture-value')
    expect(await readFile(join(workspace, 'result.txt'), 'utf8')).toBe('PRIVATE_PYTHON_OK')
  } finally {
    await runner.stop()
    await removeCommunityFixture(root)
  }
})
