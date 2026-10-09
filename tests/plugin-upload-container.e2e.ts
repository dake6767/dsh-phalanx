import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { ContainerPluginArchiveInspector } from '../src/adapters/plugin-archive-inspector.js'
import { FilePluginUpload } from '../src/adapters/plugin-upload.js'
import { ContainerPluginPreparer } from '../src/adapters/plugin-preparer.js'
import { execFileText } from '../src/adapters/runtime-command.js'

it.skipIf(!process.env.DSH_PHALANX_PRECHECK_IMAGE)('inspects private npm archives only in a disabled-network container and prepares the exact uploaded content', async () => {
  const root = await mkdtemp(join(tmpdir(), 'phalanx-private-plugin-'))
  const sentinel = join(tmpdir(), `phalanx-upload-executed-${randomUUID()}`)
  const directory = join(root, 'package')
  const config = { command: 'node', args: [], dataRoot: join(root, 'platform'),
    container: { runtime: 'podman', image: process.env.DSH_PHALANX_PRECHECK_IMAGE!, internalPort: 4180, gatewayPort: 0 },
    defaultModel: { provider: 'fixture', model: 'fixture', upstream: { baseUrl: 'https://example.test' } } }
  const uploads = new FilePluginUpload(config.dataRoot, new ContainerPluginArchiveInspector(config))
  const preparer = new ContainerPluginPreparer(config)
  const manifest = { name: '@example/private-plugin', version: '1.0.0', type: 'module', main: './index.js', description: 'Private uploaded plugin', dsh: { bundle: { patch: './cordis.patch.yml' } } }
  let serial = 0
  const pack = async (value: object) => {
    await writeFile(join(directory, 'package.json'), JSON.stringify(value))
    const destination = join(root, `packed-${++serial}`); await mkdir(destination)
    const result = JSON.parse(await execFileText('npm', ['pack', directory, '--ignore-scripts', '--json', '--pack-destination', destination], { timeout: 30000 })) as Array<{ filename: string }>
    return join(destination, result[0]!.filename)
  }
  try {
    await mkdir(directory)
    await writeFile(join(directory, 'index.js'), `import { writeFileSync } from 'node:fs'; export const name = 'private-upload-fixture'; export function apply() { writeFileSync(${JSON.stringify(sentinel)}, 'container only'); }`)
    await writeFile(join(directory, 'cordis.patch.yml'), JSON.stringify([{ insert: [{ id: 'private-upload-fixture', name: manifest.name }] }]))
    const archive = await pack(manifest)
    const uploaded = await uploads.accept('private.tgz', createReadStream(archive), new AbortController().signal)
    expect(uploaded).toMatchObject({ packageName: manifest.name, version: manifest.version })
    expect(uploaded.integrity).toBe('sha512-' + createHash('sha512').update(await readFile(archive)).digest('base64'))
    const result = await preparer.prepare({ ...uploaded, upload: { archive: uploaded.archive, integrity: uploaded.integrity } }, () => {}, new AbortController().signal)
    expect(result.integrity).toBe(uploaded.integrity)
    expect(result.description).toBe('Private uploaded plugin')
    expect(await readFile(join(config.dataRoot, 'plugins', result.artifact, 'original.tgz'))).toEqual(await readFile(archive))
    await expect(stat(sentinel)).rejects.toMatchObject({ code: 'ENOENT' })
    for (const dependency of ['file:../outside', 'link:../outside', 'git+https://example.test/repo.git', 'https://example.test/plugin.tgz']) {
      const invalid = await pack({ ...manifest, dependencies: { hidden: dependency }, peerDependencies: { hidden: '*' } })
      await expect(uploads.accept('invalid.tgz', createReadStream(invalid), new AbortController().signal)).rejects.toMatchObject({ code: 'plugin-dependency-invalid' })
    }
    const missing = await pack({ ...manifest, dsh: {} })
    await expect(uploads.accept('missing.tgz', createReadStream(missing), new AbortController().signal)).rejects.toMatchObject({ code: 'plugin-package-invalid' })
    expect(await readdir(join(config.dataRoot, 'plugins/uploads/incoming'))).toEqual([])
  } finally { await preparer.recover(); await rm(root, { recursive: true, force: true }); await rm(sentinel, { force: true }) }
}, 180000)
