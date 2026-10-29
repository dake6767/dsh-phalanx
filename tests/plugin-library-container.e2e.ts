// Validation: T2; real credentials: none; actual Linux rootless DSH. Missing inputs must fail the T2 report gate.
import { createHash, randomUUID } from 'node:crypto'
import { execFileText, containerClientEnvironment } from '../src/adapters/runtime-command.js'
import { mkdtemp, readFile, readdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { PluginLibrary } from '../src/use-cases/plugin-library.js'
import { validationPluginPreparer } from './support/validation-downloads.js'
import type { CommunityPluginStage } from '../src/domain/admin-contract.js'
import { removeCommunityFixture } from './fixtures/owned-cleanup.js'

it.skipIf(!process.env.DSH_PHALANX_PRECHECK_IMAGE)(
  'prepares the catalog-locked npm plugin and its dependencies in isolated Linux containers',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'phalanx-library-'))
    try {
      const stages: CommunityPluginStage[] = []
      const preparer = validationPluginPreparer({
        command: 'node',
        args: [],
        dataRoot: root,
        container: { runtime: 'podman', image: process.env.DSH_PHALANX_PRECHECK_IMAGE!, internalPort: 4180, gatewayPort: 0 },
        defaultModel: { provider: 'fixture', model: 'fixture', upstream: { baseUrl: 'https://example.test' } },
      })
      const library = new PluginLibrary(
        { get: async () => undefined },
        { list: async () => [], save: async () => {}, remove: async () => {} },
        {
          prepare: (input, progress, signal) =>
            preparer.prepare(
              input,
              async stage => {
                stages.push(stage)
                await progress(stage)
              },
              signal,
            ),
        },
      )
      const result = await library.prepareSuitePlugin(
        'suite:fixture-editor',
        {
          packageName: '@anysearch/anysearch-dsh',
          version: '0.1.8',
          integrity: 'sha512-N00VwXW5j2+IJKtURJIv5eaLJBqr+b/1oLL+B8pX2CfaHjIGPXop0l5fKXpr/iR9cS8cf9yjFOSeVaUa+rEO9A==',
        },
        async () => {},
        new AbortController().signal,
      )
      expect(result.integrity).toBe('sha512-N00VwXW5j2+IJKtURJIv5eaLJBqr+b/1oLL+B8pX2CfaHjIGPXop0l5fKXpr/iR9cS8cf9yjFOSeVaUa+rEO9A==')
      expect(result.bundlePatch).toContain('anysearch')
      expect(result.dependencies).toHaveProperty('@deepseek-ai/schemastery')
      expect(result.description.length).toBeGreaterThan(0)
      expect(stages).toEqual(['downloading', 'installing', 'prechecking'])
      const manifest = JSON.parse(
        await readFile(join(root, 'plugins', result.artifact, 'prepared', result.preparationId ?? result.runtimeRevision, 'manifest.json'), 'utf8'),
      )
      expect(manifest.packageName).toBe('@anysearch/anysearch-dsh')
      const dependency = JSON.parse(
        await readFile(
          join(
            root,
            'plugins',
            result.artifact,
            'prepared',
            result.preparationId ?? result.runtimeRevision,
            'node_modules/@deepseek-ai/schemastery/package.json',
          ),
          'utf8',
        ),
      )
      expect(dependency.name).toBe('@deepseek-ai/schemastery')
    } finally {
      await removeCommunityFixture(root)
    }
  },
  600_000,
)

it.skipIf(!process.env.DSH_PHALANX_PRECHECK_IMAGE)(
  'rejects a legacy plugin whose dependencies do not activate on the pinned runtime',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'phalanx-library-incompatible-'))
    try {
      const stages: CommunityPluginStage[] = []
      const preparer = validationPluginPreparer({
        command: 'node',
        args: [],
        dataRoot: root,
        container: { runtime: 'podman', image: process.env.DSH_PHALANX_PRECHECK_IMAGE!, internalPort: 4180, gatewayPort: 0 },
        defaultModel: { provider: 'fixture', model: 'fixture', upstream: { baseUrl: 'https://example.test' } },
      })
      await expect(
        preparer.prepare(
          { packageName: 'dsh-better-sidebar', version: '0.24.1' },
          async stage => {
            stages.push(stage)
          },
          new AbortController().signal,
        ),
      ).rejects.toMatchObject({ code: 'plugin-precheck-failed', cause: { message: expect.stringContaining('Inactive plugins') } })
      expect(stages).toEqual(['downloading', 'installing', 'prechecking'])
      expect(await readdir(join(root, 'plugins/staging'))).toEqual([])
      expect(await readdir(join(root, 'plugins'))).not.toContain('artifacts')
    } finally {
      await removeCommunityFixture(root)
    }
  },
  600_000,
)

it.skipIf(!process.env.DSH_PHALANX_PRECHECK_IMAGE)(
  'retains staging on removal failure and recovers only containers owned by this library',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'phalanx-library-cleanup-'))
    const marker = join(root, 'block-removal')
    const wrapper = join(root, 'container-runtime')
    const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'"
    await writeFile(wrapper, '#!/bin/sh\nif [ "$1" = rm ] && [ -f ' + quote(marker) + ' ]; then exit 87; fi\nexec podman "$@"\n', { mode: 0o700 })
    await writeFile(marker, 'blocked')
    const image = process.env.DSH_PHALANX_PRECHECK_IMAGE!
    const preparer = validationPluginPreparer({
      command: 'node',
      args: [],
      dataRoot: root,
      container: { runtime: wrapper, image, internalPort: 4180, gatewayPort: 0 },
      defaultModel: { provider: 'fixture', model: 'fixture', upstream: { baseUrl: 'https://example.test' } },
    })
    const owner = createHash('sha256').update(root).digest('hex')
    const names = [`phalanx-precheck-test-${randomUUID()}`, `phalanx-precheck-other-${randomUUID()}`]
    const env = containerClientEnvironment()
    const pod = (...args: string[]) => execFileText('podman', args, { env, timeout: 30000 })
    try {
      await expect(
        preparer.prepare({ packageName: '@anysearch/anysearch-dsh', version: '0.1.7' }, async () => {}, new AbortController().signal),
      ).rejects.toMatchObject({ code: 'plugin-cleanup-failed' })
      expect((await readdir(join(root, 'plugins/staging'))).length).toBe(1)
      for (const [index, name] of names.entries())
        await pod(
          'run',
          '-d',
          '--name',
          name,
          '--label',
          `dsh-phalanx.precheck=${index === 0 ? owner : 'other-fixture-owner'}`,
          '--network',
          'none',
          image,
          'node',
          '-e',
          'setInterval(() => {}, 1000)',
        )
      await expect(preparer.recover()).rejects.toThrow()
      expect((await readdir(join(root, 'plugins/staging'))).length).toBe(1)
      await rm(marker)
      await preparer.recover()
      expect((await pod('ps', '-a', '--filter', `name=${names[0]}`, '--format', '{{.Names}}')).trim()).toBe('')
      expect((await pod('ps', '--filter', `name=${names[1]}`, '--format', '{{.Names}}')).trim()).toBe(names[1])
      expect(await readdir(join(root, 'plugins'))).not.toContain('staging')
    } finally {
      await Promise.all(names.map(name => pod('rm', '-f', '--ignore', name)))
      await rm(marker, { force: true })
      await preparer.recover()
      await removeCommunityFixture(root)
    }
  },
  120000,
)
