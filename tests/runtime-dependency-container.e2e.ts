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
