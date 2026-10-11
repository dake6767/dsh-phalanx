import { createHash, randomUUID } from 'node:crypto'
import { execFileText, containerClientEnvironment } from '../src/adapters/runtime-command.js'
import { mkdtemp, readFile, readdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { ContainerPluginPreparer } from '../src/adapters/plugin-preparer.js'
import type { CommunityPluginStage } from '../src/domain/admin-contract.js'

it.skipIf(!process.env.DSH_PHALANX_PRECHECK_IMAGE)('prepares the real npm plugin and its dependencies in isolated Linux containers', async () => {
  const root = await mkdtemp(join(tmpdir(), 'phalanx-library-'))
  try {
    const stages: CommunityPluginStage[] = []
    const preparer = new ContainerPluginPreparer({ command: 'node', args: [], dataRoot: root,
      container: { runtime: 'podman', image: process.env.DSH_PHALANX_PRECHECK_IMAGE!, internalPort: 4180, gatewayPort: 0 },
      defaultModel: { provider: 'fixture', model: 'fixture', upstream: { baseUrl: 'https://example.test' } } })
    const result = await preparer.prepare({ packageName: '@anysearch/anysearch-dsh', version: '0.1.8' }, stage => stages.push(stage), new AbortController().signal)
    expect(result.integrity).toBe('sha512-N00VwXW5j2+IJKtURJIv5eaLJBqr+b/1oLL+B8pX2CfaHjIGPXop0l5fKXpr/iR9cS8cf9yjFOSeVaUa+rEO9A==')
    expect(result.bundlePatch).toContain('anysearch')
    expect(result.dependencies).toHaveProperty('@deepseek-ai/schemastery')
    expect(result.description.length).toBeGreaterThan(0)
    expect(stages).toEqual(['downloading', 'installing', 'prechecking'])
    const manifest = JSON.parse(await readFile(join(root, 'plugins', result.artifact, 'prepared', result.preparationId ?? result.runtimeRevision, 'manifest.json'), 'utf8'))
    expect(manifest.packageName).toBe('@anysearch/anysearch-dsh')
    const dependency = JSON.parse(await readFile(join(root, 'plugins', result.artifact, 'prepared', result.preparationId ?? result.runtimeRevision, 'node_modules/@deepseek-ai/schemastery/package.json'), 'utf8'))
    expect(dependency.name).toBe('@deepseek-ai/schemastery')
  } finally { await rm(root, { recursive: true, force: true }) }
}, 600_000)

it.skipIf(!process.env.DSH_PHALANX_PRECHECK_IMAGE)('rejects a legacy plugin whose dependencies do not activate on the pinned runtime', async () => {
  const root = await mkdtemp(join(tmpdir(), 'phalanx-library-incompatible-'))
  try {
    const stages: CommunityPluginStage[] = []
    const preparer = new ContainerPluginPreparer({ command: 'node', args: [], dataRoot: root,
      container: { runtime: 'podman', image: process.env.DSH_PHALANX_PRECHECK_IMAGE!, internalPort: 4180, gatewayPort: 0 },
      defaultModel: { provider: 'fixture', model: 'fixture', upstream: { baseUrl: 'https://example.test' } } })
    await expect(preparer.prepare({ packageName: 'dsh-better-sidebar', version: '0.24.1' }, stage => stages.push(stage), new AbortController().signal))
      .rejects.toMatchObject({ code: 'plugin-precheck-failed', cause: { message: expect.stringContaining('Inactive plugins') } })
    expect(stages).toEqual(['downloading', 'installing', 'prechecking'])
    expect(await readdir(join(root, 'plugins/staging'))).toEqual([])
    expect(await readdir(join(root, 'plugins'))).not.toContain('artifacts')
  } finally { await rm(root, { recursive: true, force: true }) }
}, 600_000)

it.skipIf(!process.env.DSH_PHALANX_PRECHECK_IMAGE)('retains staging on removal failure and recovers only containers owned by this library', async () => {
  const root = await mkdtemp(join(tmpdir(), 'phalanx-library-cleanup-'))
  const marker = join(root, 'block-removal')
  const wrapper = join(root, 'container-runtime')
  const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'"
  await writeFile(wrapper, '#!/bin/sh\nif [ "$1" = rm ] && [ -f ' + quote(marker) + ' ]; then exit 87; fi\nexec podman "$@"\n', { mode: 0o700 })
  await writeFile(marker, 'blocked')
  const image = process.env.DSH_PHALANX_PRECHECK_IMAGE!
  const preparer = new ContainerPluginPreparer({ command: 'node', args: [], dataRoot: root,
    container: { runtime: wrapper, image, internalPort: 4180, gatewayPort: 0 },
    defaultModel: { provider: 'fixture', model: 'fixture', upstream: { baseUrl: 'https://example.test' } } })
  const owner = createHash('sha256').update(root).digest('hex')
  const names = [`phalanx-precheck-test-${randomUUID()}`, `phalanx-precheck-other-${randomUUID()}`]
  const env = containerClientEnvironment()
  const pod = (...args: string[]) => execFileText('podman', args, { env, timeout: 30000 })
  try {
    await expect(preparer.prepare({ packageName: '@anysearch/anysearch-dsh', version: '0.1.7' }, () => {}, new AbortController().signal)).rejects.toMatchObject({ code: 'plugin-cleanup-failed' })
    expect((await readdir(join(root, 'plugins/staging'))).length).toBe(1)
    for (const [index, name] of names.entries()) await pod('run', '-d', '--name', name, '--label', `dsh-phalanx.precheck=${index === 0 ? owner : 'other-fixture-owner'}`, '--network', 'none', image, 'node', '-e', 'setInterval(() => {}, 1000)')
    await expect(preparer.recover()).rejects.toThrow()
    expect((await readdir(join(root, 'plugins/staging'))).length).toBe(1)
    await rm(marker)
    await preparer.recover()
    expect((await pod('ps', '-a', '--filter', `name=${names[0]}`, '--format', '{{.Names}}')).trim()).toBe('')
    expect((await pod('ps', '--filter', `name=${names[1]}`, '--format', '{{.Names}}')).trim()).toBe(names[1])
    expect(await readdir(join(root, 'plugins'))).not.toContain('staging')
  } finally {
    await Promise.all(names.map(name => pod('rm', '-f', '--ignore', name)))
    await rm(marker, { force: true }); await preparer.recover(); await rm(root, { recursive: true, force: true })
  }
}, 120000)
