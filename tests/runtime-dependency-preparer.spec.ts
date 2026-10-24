import { FileRuntimeDependencyStore } from '../src/adapters/runtime-dependency-store.js'
import { runtimeDependencyInput } from '../src/domain/runtime-dependency.js'
import { execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { access, mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { DevelopmentExecutionProcess } from '../src/adapters/execution-development-process.js'
import { FileExecutionArtifacts } from '../src/adapters/execution-artifacts.js'
import { RuntimeDependencyPreparer } from '../src/adapters/runtime-dependency-preparer.js'
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'runtime-dependency-')); roots.push(root)
  const process = Object.assign(new DevelopmentExecutionProcess(), { isolated: false, canDiscardArtifacts: true, recover: async () => {}, imageIdentity: async () => 'development' })
  return new RuntimeDependencyPreparer(process, new FileExecutionArtifacts(root))
}
const input = { name: 'example', prepareCommand: 'mkdir bin; printf "#!/bin/sh\\necho ready\\n" > bin/example; chmod +x bin/example', pathDirectories: ['bin'], checkCommand: 'example' }
test('prepares at a fixed path, checks in a fresh home, freezes output and preserves full logs without host credentials', async () => {
  const preparer = await fixture(); await preparer.recover()
  const key = 'PHALANX_TEST_PLATFORM_CREDENTIAL'; process.env[key] = 'private-fixture'
  try {
    const definition = { ...input, prepareCommand: 'set -eu; ' + input.prepareCommand + '; test -z "${PHALANX_TEST_PLATFORM_CREDENTIAL:-}"; test "$PWD" -ef "$RD_OUT"; touch "$HOME/preparation-only"; node -e "process.stdout.write(\'x\'.repeat(300000))"', checkCommand: 'test ! -e "$HOME/preparation-only" && example' }
    const identity = preparer.identity(definition); process.env[key] = 'changed-fixture'
    expect(preparer.identity(definition)).toBe(identity)
    const version = await preparer.prepare(definition, async () => {}, new AbortController().signal)
    expect(version.isolated).toBe(false); expect(version.directory).toBe(version.mountedPath)
    expect(version.commands).toEqual(['example']); expect(version.log.length).toBeGreaterThan(300000)
    expect((await stat(join(version.directory, 'bin/example'))).mode & 0o222).toBe(0)
    expect(version.checks.every(check => check.passed)).toBe(true)
    await preparer.collect([])
  } finally { delete process.env[key] }
})
test.each([
  ['path-invalid', 'mkdir bin', ['missing'], undefined],
  ['path-invalid', 'mkdir bin', ['bin'], undefined],
  ['link-escape', 'mkdir bin; ln -s /bin/sh bin/escape', ['bin'], undefined],
  ['command-conflict', input.prepareCommand + '; mkdir other; cp bin/example other/example', ['bin', 'other'], undefined],
  ['check-failed', input.prepareCommand, ['bin'], 'exit 7'],
] as const)('rejects %s with explicit validation results', async (code, prepareCommand, pathDirectories, checkCommand) => {
  const preparer = await fixture()
  await expect(preparer.prepare({ name: 'example', prepareCommand, pathDirectories: [...pathDirectories], ...(checkCommand ? { checkCommand } : {}) }, async () => {}, new AbortController().signal)).rejects.toMatchObject({ code, checks: expect.arrayContaining([expect.objectContaining({ passed: false })]) })
})
test('records a failed check-command when its process times out', async () => {
  const root = await mkdtemp(join(tmpdir(), 'runtime-dependency-timeout-')); roots.push(root)
  const development = new DevelopmentExecutionProcess()
  let calls = 0
  const process = { isolated: false, canDiscardArtifacts: true, recover: async () => {}, imageIdentity: async () => 'development', run: (...args: Parameters<DevelopmentExecutionProcess['run']>) => {
    if (++calls === 3) return Promise.reject(new Error('simulated process timeout'))
    return development.run(...args)
  } }
  const preparer = new RuntimeDependencyPreparer(process, new FileExecutionArtifacts(root))
  await expect(preparer.prepare(input, async () => {}, new AbortController().signal)).rejects.toMatchObject({ code: 'check-failed', checks: expect.arrayContaining([{ kind: 'check-command', passed: false, detail: expect.any(String) }]) })
})
test('credential and cwd acceptance assertions fail if the process boundary regresses', async () => {
  for (const corruption of ['credential', 'cwd']) {
    const root = await mkdtemp(join(tmpdir(), 'runtime-dependency-negative-')); roots.push(root)
    const development = new DevelopmentExecutionProcess()
    const process = { isolated: false, canDiscardArtifacts: true, recover: async () => {}, imageIdentity: async () => 'development', run: (...args: Parameters<DevelopmentExecutionProcess['run']>) => {
      const [request, emit, signal] = args
      return development.run({ ...request, ...(corruption === 'cwd' ? { cwd: tmpdir() } : {}), environment: { ...request.environment, ...(corruption === 'credential' ? { PHALANX_TEST_PLATFORM_CREDENTIAL: 'private-fixture' } : {}) } }, emit, signal)
    } }
    const preparer = new RuntimeDependencyPreparer(process, new FileExecutionArtifacts(root))
    await expect(preparer.prepare({ ...input, prepareCommand: 'set -eu; test -z "${PHALANX_TEST_PLATFORM_CREDENTIAL:-}"; test "$PWD" -ef "$RD_OUT"; ' + input.prepareCommand }, async () => {}, new AbortController().signal)).rejects.toMatchObject({ code: 'prepare-failed' })
  }
})

test('requests the selected registry during real preparation and lets explicit npm arguments override the default', async () => {
  const { DownloadSources } = await import('../src/use-cases/download-sources.js')
  const requests: string[] = []
  const registry = async (name: string) => {
    const server = createServer((request, response) => {
      requests.push(name + request.url)
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ name: 'fixture-package', 'dist-tags': { latest: '1.0.0' }, versions: { '1.0.0': { name: 'fixture-package', version: '1.0.0' } } }))
    })
    server.listen(0, '127.0.0.1'); await once(server, 'listening')
    return { server, url: `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}` }
  }
  const first = await registry('first'), second = await registry('second')
  const actor = { username: 'admin', spaceId: 'a', sessionEpoch: 0 }
  let selection: import('../src/domain/download-source.js').DownloadSourceSelection = { preset: 'official', overrides: { npm: first.url } }
  const sources = new DownloadSources({ get: () => ({ ...actor, email: '', admin: true, groupId: 'admin', disabled: false, createdAt: 0, updatedAt: 0 }) }, { get: () => selection, save: value => { selection = value } })
  const root = await mkdtemp(join(tmpdir(), 'download-preparation-')); roots.push(root)
  const execution = Object.assign(new DevelopmentExecutionProcess(), { isolated: false, canDiscardArtifacts: true, recover: async () => {}, imageIdentity: async () => 'development' })
  const preparer = new RuntimeDependencyPreparer(execution, new FileExecutionArtifacts(root), undefined, sources)
  const definition = { ...input, prepareCommand: 'set -eu; npm view fixture-package version --update-notifier=false --fetch-retries=0; ' + input.prepareCommand }
  try {
    const initial = await preparer.prepare(definition, async () => {}, new AbortController().signal)
    expect(requests).toContain('first/fixture-package')
    requests.length = 0
    sources.save(actor, { preset: 'mainland', overrides: { npm: second.url } })
    expect(preparer.identity(definition)).toBe(initial.identity)
    const changed = await preparer.prepare(definition, async () => {}, new AbortController().signal)
    expect(requests).toEqual(['second/fixture-package'])
    expect(changed.log).toContain(second.url)
    requests.length = 0
    await preparer.prepare({ ...definition, prepareCommand: `set -eu; npm view fixture-package version --update-notifier=false --fetch-retries=0 --registry=${first.url}; ` + input.prepareCommand }, async () => {}, new AbortController().signal)
    expect(requests).toEqual(['first/fixture-package'])
    requests.length = 0
    await preparer.prepare({ ...input, checkCommand: 'npm view fixture-package version --update-notifier=false --fetch-retries=0 && example' }, async () => {}, new AbortController().signal)
    expect(requests).toEqual(['second/fixture-package'])
    // Use the exact already-installed Corepack payload; a fresh preparation HOME
    // must not download another package manager just to test its registry.
    const manager = (JSON.parse(await readFile('package.json', 'utf8')) as { packageManager: string }).packageManager.split('@')[1]!
    const pnpm = join(process.env.COREPACK_HOME ?? join(homedir(), '.cache/node/corepack'), 'v1/pnpm', manager, 'bin/pnpm.cjs')
    await access(pnpm)
    const pnpmCommand = `node '${pnpm.replaceAll("'", "'\\''")}'`
    for (const override of ['', '--registry='+first.url]) {
      requests.length = 0
      let preparationLog = ''
      await preparer.prepare({ ...input, checkCommand: `${pnpmCommand} view fixture-package version ${override} && example` }, async log => { preparationLog = log }, new AbortController().signal).catch(error => { throw new Error(preparationLog, { cause: error }) })
      expect(requests).toEqual([override ? 'first/fixture-package' : 'second/fixture-package'])
    }
    for (const name of ['PNPM_CONFIG_REGISTRY', 'pnpm_config_registry']) {
      requests.length = 0
      await preparer.prepare({ ...input, checkCommand: `${name}=${first.url} ${pnpmCommand} view fixture-package version && example` }, async () => {}, new AbortController().signal)
      expect(requests).toEqual(['first/fixture-package'])
    }
    for (const name of ['NPM_CONFIG_REGISTRY', 'npm_config_registry']) {
      requests.length = 0
      const explicit = await preparer.prepare({ ...definition, prepareCommand: `set -eu; ${name}=${first.url} npm view fixture-package version --update-notifier=false --fetch-retries=0; ` + input.prepareCommand }, async () => {}, new AbortController().signal)
      expect(requests).toEqual(['first/fixture-package'])
      expect(explicit.log).toContain(`${name}=${first.url}`)
    }
  } finally { await preparer.collect([]); first.server.closeAllConnections(); second.server.closeAllConnections(); await Promise.all([new Promise<void>(resolve => first.server.close(() => resolve())), new Promise<void>(resolve => second.server.close(() => resolve()))]) }
}, 20_000)


test('publishes an exact Python venv interpreter and site-packages metadata without advertising pip commands', async () => {
  const preparer = await fixture(); await preparer.recover()
  const python = execFileSync('python3', ['-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' }).trim().replaceAll("'", "'\\''")
  const definition = { name: 'python-fixture', type: 'python-library' as const, packages: ['fixture==1.0'], pathDirectories: ['venv/bin'],
    prepareCommand: `'${python}' -m venv --copies --without-pip "$RD_OUT/venv"`, checkCommand: '"$RD_OUT/venv/bin/python3" -c "import sys; assert sys.prefix != sys.base_prefix"' }
  let log = ''
  const version = await preparer.prepare(definition, async value => { log = value }, new AbortController().signal).catch(error => { throw new Error(log, { cause: error }) })
  expect(version.commands).toEqual(['python3'])
  expect(version.commandPaths).toEqual({ python3: 'venv/bin/python3' })
  expect(version.python).toEqual({ name: 'python-fixture', interpreter: 'venv/bin/python3', sitePackages: expect.stringMatching(/^venv\/lib\/python3\.\d+\/site-packages$/u), abi: expect.stringMatching(/^cpython-3\d+/u) })
  expect(version.checks.every(check => check.passed)).toBe(true)
  await preparer.collect([])
})

test('prepares immutable resource files without PATH commands while preserving whole-tree and custom checks', async () => {
  const preparer = await fixture()
  const definition = runtimeDependencyInput({ name: '办公-sdk', type: 'resource', prepareCommand: 'mkdir sdk; printf RESOURCE_ONE > sdk/data.txt', checkCommand: 'test "$(cat sdk/data.txt)" = RESOURCE_ONE' })
  expect(definition.pathDirectories).toEqual([])
  const version = await preparer.prepare(definition, async () => {}, new AbortController().signal)
  expect(version.commands).toEqual([]); expect(version.commandPaths).toEqual({})
  const metadata = join(version.directory, '..', 'resources.json'), store = new FileRuntimeDependencyStore(metadata)
  store.save({ ...definition, source: 'manual', stage: 'ready', current: version, updatedAt: 1, log: version.log, checks: version.checks })
  expect(new FileRuntimeDependencyStore(metadata).list()[0]).toMatchObject({ type: 'resource', current: { commands: [] } })
  expect(await readFile(join(version.directory, 'sdk/data.txt'), 'utf8')).toBe('RESOURCE_ONE')
  expect((await stat(join(version.directory, 'sdk/data.txt'))).mode & 0o222).toBe(0)
  expect(version.checks).toContainEqual({ kind: 'check-command', passed: true })
  expect(preparer.identity(definition)).not.toBe(preparer.identity({ name: definition.name, prepareCommand: definition.prepareCommand, pathDirectories: [], checkCommand: definition.checkCommand! }))
  await expect(preparer.prepare({ ...definition, prepareCommand: 'ln -s /etc/passwd escape' }, async () => {}, new AbortController().signal)).rejects.toMatchObject({ code: 'link-escape' })
  expect(() => runtimeDependencyInput({ name: 'ordinary', prepareCommand: 'mkdir sdk', pathDirectories: [] })).toThrow(expect.objectContaining({ code: 'runtime-dependency-invalid' }))
  await preparer.collect([])
})
