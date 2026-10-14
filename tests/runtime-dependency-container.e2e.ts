import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { ContainerExecutionProcess } from '../src/adapters/execution-container-process.js'
import { FileExecutionArtifacts } from '../src/adapters/execution-artifacts.js'
import { RuntimeDependencyPreparer } from '../src/adapters/runtime-dependency-preparer.js'
import { runtimeSettings } from './support/real-dsh-kit.js'
import { assertPinnedDshRevision, runtimeSection } from './support/real-dsh-runtime.js'

it.skipIf(!runtimeSettings.containerImage)('prepares npm and downloaded CLI dependencies and validates their immutable fixed paths in fresh containers', async () => {
  assertPinnedDshRevision(runtimeSettings)
  const root = await mkdtemp(join(tmpdir(), 'runtime-dependency-container-'))
  const process = new ContainerExecutionProcess(runtimeSection(root, 'https://example.test', runtimeSettings)), artifacts = new FileExecutionArtifacts(join(root, '.trees'))
  const preparer = new RuntimeDependencyPreparer(process, artifacts)
  try {
    await preparer.recover(); expect(preparer.isolated).toBe(true)
    for (const definition of [
      { name: 'mmx', prepareCommand: 'npm install --prefix "$RD_OUT" --ignore-scripts --no-audit --no-fund --registry=https://registry.npmmirror.com mmx-cli@1.0.28', pathDirectories: ['node_modules/.bin'], checkCommand: 'mmx --version' },
      { name: 'news', prepareCommand: 'mkdir bin; curl -fL --connect-timeout 15 --max-time 180 https://mat1.gtimg.com/qqcdn/qqnews/cli/hub/tencent-news/setup.sh -o /tmp/news-setup.sh && TENCENT_NEWS_INSTALL="$RD_OUT/.news" sh /tmp/news-setup.sh && cp .news/bin/tencent-news-cli bin/tencent-news-cli', pathDirectories: ['bin'], checkCommand: 'tencent-news-cli help' },
    ]) {
      const prepared = await preparer.prepare({ ...definition, prepareCommand: definition.prepareCommand + ' && test "$PWD" = "$RD_OUT" && touch "$HOME/preparation-only"', checkCommand: 'test ! -e "$HOME/preparation-only" && ' + definition.checkCommand }, async () => {}, new AbortController().signal)
      expect(prepared.checks.every(check => check.passed)).toBe(true)
      expect(prepared.commands).toContain(definition.name === 'mmx' ? 'mmx' : 'tencent-news-cli')
      const output: string[] = []
      const exit = await process.run({ mounts: [{ host: prepared.directory, mounted: prepared.mountedPath, readOnly: true }], cwd: prepared.mountedPath, command: '/bin/sh', argv: ['-c', 'if touch "$RD_OUT/write-test" 2>/dev/null; then exit 9; fi; ' + definition.checkCommand], stdin: new Uint8Array(), environment: { HOME: '/tmp/phalanx-home', TMPDIR: '/tmp', RD_OUT: prepared.mountedPath, PATH: [...prepared.pathDirectories.map(path => `${prepared.mountedPath}/${path}`), '/usr/local/bin', '/usr/bin', '/bin'].join(':') } }, async event => { output.push(Buffer.from(event.data).toString()) }, new AbortController().signal)
      expect(exit).toBe(0); expect(output.join('').length).toBeGreaterThan(0)
    }
  } finally { await process.stop(); await artifacts.collect([]); await rm(root, { recursive: true, force: true }) }
}, 600000)

it.skipIf(!runtimeSettings.containerImage)('keeps the current command callable during preparation and protects an active old version across two successful switches', async () => {
  const { RuntimeDependencies } = await import('../src/use-cases/runtime-dependencies.js')
  const { FileRuntimeDependencyStore } = await import('../src/adapters/runtime-dependency-store.js')
  const { mkdir, readdir, writeFile } = await import('node:fs/promises')
  assertPinnedDshRevision(runtimeSettings)
  const root = await mkdtemp(join(tmpdir(), 'dependency-switch-')), process = new ContainerExecutionProcess(runtimeSection(root, 'https://example.test', runtimeSettings))
  const tree = join(root, '.trees'), artifacts = new FileExecutionArtifacts(tree), store = new FileRuntimeDependencyStore(join(root, 'library.json'))
  const actor = { username: 'admin', spaceId: 'admin-space', sessionEpoch: 0 }
  const dependencies = new RuntimeDependencies({ get: () => ({ ...actor, admin: true, disabled: false, groupId: 'admin', email: '', createdAt: 0, updatedAt: 0 }) }, store, new RuntimeDependencyPreparer(process, artifacts), { now: () => Date.now() })
  const definition = (version: string, gate = false) => ({ name: 'example', pathDirectories: ['bin'], checkCommand: 'example', prepareCommand: `set -eu; mkdir bin; printf '%s\n' '${version}' > version; printf '%s\n' '#!/bin/sh' 'if [ "\${1:-}" = hold ]; then echo held; while [ ! -e /call-gate/release ]; do sleep 0.02; done; fi' 'cat "$RD_OUT/version"' > bin/example; chmod +x bin/example; ${gate ? 'echo candidate-waiting; while [ ! -e release ]; do sleep 0.02; done' : ':'}` })
  const callGate = join(root, 'call-gate'); await mkdir(callGate)
  const invoke = (hold = false, started = () => {}) => dependencies.withPrepared(['example'], async versions => {
    const version = versions[0]!, output: string[] = []
    const exit = await process.run({ mounts: [{ host: version.directory, mounted: version.mountedPath, readOnly: true }, { host: callGate, mounted: '/call-gate' }], cwd: version.mountedPath, command: version.mountedPath + '/bin/example', argv: hold ? ['hold'] : [], stdin: new Uint8Array(), environment: { HOME: '/tmp/phalanx-home', RD_OUT: version.mountedPath, PATH: '/usr/local/bin:/usr/bin:/bin' } }, async event => { const chunk = Buffer.from(event.data).toString(); output.push(chunk); if (chunk.includes('held')) started() }, new AbortController().signal)
    expect(exit).toBe(0); return output.join('')
  })
  try {
    await dependencies.recover(); dependencies.create(actor, definition('v1')); await dependencies.prepare(actor, 'example')
    const first = dependencies.ready(['example'])[0]!.id
    let started!: () => void; const held = new Promise<void>(resolve => { started = resolve }), oldCall = invoke(true, started); await held
    dependencies.update(actor, 'example', definition('v2', true))
    await expect.poll(() => dependencies.view(actor, 'example').log.includes('candidate-waiting')).toBe(true)
    expect(await invoke()).toBe('v1\n')
    const candidate = (await readdir(tree)).find(id => id !== first)!
    await writeFile(join(tree, candidate, 'release'), '')
    await dependencies.prepare(actor, 'example'); expect(await invoke()).toBe('v2\n')
    dependencies.update(actor, 'example', definition('v3')); await dependencies.prepare(actor, 'example')
    expect(await invoke()).toBe('v3\n'); expect(await readdir(tree)).toContain(first)
    await writeFile(join(callGate, 'release'), ''); expect(await oldCall).toBe('held\nv1\n')
    expect(await readdir(tree)).not.toContain(first)
    const current = dependencies.ready(['example'])[0]!.id
    dependencies.update(actor, 'example', { ...definition('broken'), checkCommand: 'exit 7' }); await dependencies.prepare(actor, 'example')
    expect(dependencies.view(actor, 'example')).toMatchObject({ stage: 'failed', failureCode: 'check-failed' })
    expect(dependencies.ready(['example'])[0]!.id).toBe(current); expect(await invoke()).toBe('v3\n')
  } finally { await writeFile(join(callGate, 'release'), ''); await process.stop(); await dependencies.stop(); await artifacts.collect([]); await rm(root, { recursive: true, force: true }) }
}, 180000)
