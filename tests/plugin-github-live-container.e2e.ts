// Validation: T4; real credentials: none; optional live GitHub precheck through the configured prefixes on actual Linux rootless DSH, outside required release acceptance.
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { resolveDownloadSources } from '../src/domain/download-source.js'
import { GithubPluginArchives } from '../src/adapters/github-plugin-archives.js'
import { HttpGithubPluginSource } from '../src/adapters/github-plugin-source.js'
import { ContainerPluginArchiveInspector } from '../src/adapters/plugin-archive-inspector.js'
import { ContainerPluginSourcePacker } from '../src/adapters/plugin-source-packer.js'
import { FilePluginUpload } from '../src/adapters/plugin-upload.js'
import { removeCommunityFixture } from './fixtures/owned-cleanup.js'
import { validationDownloadSelection, validationPluginPreparer } from './support/validation-downloads.js'

it('prechecks the public sample repository from its default branch with its real package name', async () => {
  const image = process.env.DSH_PHALANX_PRECHECK_IMAGE
  if (!image) throw Error('DSH_PHALANX_PRECHECK_IMAGE is required for the live GitHub precheck')
  const root = await mkdtemp(join(tmpdir(), 'phalanx-github-live-'))
  const config = {
    command: 'node',
    args: [],
    dataRoot: join(root, 'platform'),
    container: { runtime: 'podman', image, internalPort: 4180, gatewayPort: 0 },
    defaultModel: { provider: 'fixture', model: 'fixture', upstream: { baseUrl: 'https://example.test' } },
  }
  const preparer = validationPluginPreparer(config)
  const github = new GithubPluginArchives(
    config.dataRoot,
    new HttpGithubPluginSource({ current: () => resolveDownloadSources(validationDownloadSelection()) }),
    new ContainerPluginSourcePacker(config),
    new FilePluginUpload(config.dataRoot, new ContainerPluginArchiveInspector(config)),
  )
  try {
    const signal = AbortSignal.timeout(900_000)
    const revision = await github.resolve('kingOfSoySauce/dsh-liang-skin', signal)
    expect(revision.commit).toMatch(/^[a-f0-9]{40}$/u)
    const packed = await github.pack(revision, signal)
    expect(packed.packageName).toBe('@leon___/dsh-client-liang-intensity-skin')
    const prepared = await preparer.prepare({ ...packed, upload: { archive: packed.archive, integrity: packed.integrity } }, async () => {}, signal)
    expect(prepared).toMatchObject({ packageName: packed.packageName, version: packed.version, integrity: packed.integrity })
    console.log(JSON.stringify({ commit: revision.commit, packageName: prepared.packageName, version: prepared.version, integrity: prepared.integrity }))
  } finally {
    await preparer.recover()
    await removeCommunityFixture(root)
  }
}, 960_000)
