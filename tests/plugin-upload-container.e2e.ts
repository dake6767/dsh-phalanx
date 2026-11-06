// Validation: T2; real credentials: none; actual Linux rootless DSH. Missing inputs must fail the T2 report gate.
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { expect, it } from 'vitest'
import { ContainerPluginArchiveInspector } from '../src/adapters/plugin-archive-inspector.js'
import { FilePluginUpload } from '../src/adapters/plugin-upload.js'
import { ContainerPluginSourcePacker } from '../src/adapters/plugin-source-packer.js'
import { validationPluginPreparer } from './support/validation-downloads.js'
import { execFileText } from '../src/adapters/runtime-command.js'
import { removeCommunityFixture } from './fixtures/owned-cleanup.js'

it.skipIf(!process.env.DSH_PHALANX_PRECHECK_IMAGE)(
  'inspects private npm archives and packs GitHub sources only in disabled-network containers, then prepares the exact content',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'phalanx-private-plugin-'))
    // The same absolute path must be writable in both namespaces to detect host execution.
    const sentinel = join('/tmp', `phalanx-upload-executed-${randomUUID()}`)
    const directory = join(root, 'package')
    const config = {
      command: 'node',
      args: [],
      dataRoot: join(root, 'platform'),
      container: { runtime: 'podman', image: process.env.DSH_PHALANX_PRECHECK_IMAGE!, internalPort: 4180, gatewayPort: 0 },
      defaultModel: { provider: 'fixture', model: 'fixture', upstream: { baseUrl: 'https://example.test' } },
    }
    const uploads = new FilePluginUpload(config.dataRoot, new ContainerPluginArchiveInspector(config))
    const preparer = validationPluginPreparer(config)
    const manifest = {
      name: '@example/private-plugin',
      version: '1.0.0',
      type: 'module',
      main: './index.js',
      description: 'Private uploaded plugin',
      dsh: { bundle: { patch: './cordis.patch.yml' } },
    }
    let serial = 0
    const pack = async (value: object) => {
      await writeFile(join(directory, 'package.json'), JSON.stringify(value))
      const destination = join(root, `packed-${++serial}`)
      await mkdir(destination)
      const result = JSON.parse(
        await execFileText('npm', ['pack', directory, '--ignore-scripts', '--json', '--pack-destination', destination], { timeout: 30000 }),
      ) as Array<{ filename: string }>
      return join(destination, result[0]!.filename)
    }
    try {
      await mkdir(directory)
      await writeFile(
        join(directory, 'index.js'),
        `import { writeFileSync } from 'node:fs'; export const name = 'private-upload-fixture'; export function apply() { writeFileSync(${JSON.stringify(sentinel)}, 'container only'); }`,
      )
      await writeFile(join(directory, 'cordis.patch.yml'), JSON.stringify([{ insert: [{ id: 'private-upload-fixture', name: manifest.name }] }]))
      const archive = await pack(manifest)
      const uploaded = await uploads.accept('private.tgz', createReadStream(archive), new AbortController().signal)
      expect(uploaded).toMatchObject({ packageName: manifest.name, version: manifest.version })
      expect(uploaded.integrity).toBe(
        'sha512-' +
          createHash('sha512')
            .update(await readFile(archive))
            .digest('base64'),
      )
      const result = await preparer.prepare(
        { ...uploaded, upload: { archive: uploaded.archive, integrity: uploaded.integrity } },
        async () => {},
        new AbortController().signal,
      )
      expect(result.integrity).toBe(uploaded.integrity)
      expect(result.description).toBe('Private uploaded plugin')
      expect(await readFile(join(config.dataRoot, 'plugins', result.artifact, 'original.tgz'))).toEqual(await readFile(archive))
      await expect(stat(sentinel)).rejects.toMatchObject({ code: 'ENOENT' })
      for (const dependency of ['file:../outside', 'link:../outside', 'git+https://example.test/repo.git', 'https://example.test/plugin.tgz']) {
        const invalid = await pack({ ...manifest, dependencies: { hidden: dependency }, peerDependencies: { hidden: '*' } })
        await expect(uploads.accept('invalid.tgz', createReadStream(invalid), new AbortController().signal)).rejects.toMatchObject({
          code: 'plugin-dependency-invalid',
        })
      }
      const missing = await pack({ ...manifest, dsh: {} })
      await expect(uploads.accept('missing.tgz', createReadStream(missing), new AbortController().signal)).rejects.toMatchObject({
        code: 'plugin-package-invalid',
      })
      expect(await readdir(join(config.dataRoot, 'plugins/uploads/incoming'))).toEqual([])

      // A GitHub source archive is packed in the disabled-network container without any pack script, then checked as an upload.
      const packer = new ContainerPluginSourcePacker(config)
      const repository = join(root, 'repository'),
        top = join(repository, 'dsh-plugin-0123456789abcdef0123456789abcdef01234567')
      await mkdir(join(top, 'lib'), { recursive: true })
      await writeFile(join(top, 'index.js'), await readFile(join(directory, 'index.js')))
      await writeFile(join(top, 'cordis.patch.yml'), JSON.stringify([{ insert: [{ id: 'github-source-fixture', name: '@example/github-plugin' }] }]))
      await writeFile(join(top, 'lib/client.js'), 'export {}')
      await writeFile(join(top, 'README.md'), 'Readme that npm always packs')
      await mkdir(join(top, 'docs'))
      await writeFile(join(top, 'docs/notes.md'), 'Repository file outside the declared files list')
      await writeFile(join(top, '.npmrc'), 'ignore-scripts=false\npack-destination=/tmp\n')
      // /output is the only host-visible writable mount, so any script that ran would leave its marker there.
      const scripts = Object.fromEntries(['prepare', 'prepack', 'postpack'].map(name => [name, `touch /output/ran-${name}`]))
      const source = async (value: object) => {
        await writeFile(join(top, 'package.json'), JSON.stringify(value))
        const archive = join(root, `source-${++serial}.tar.gz`)
        await execFileText('tar', ['-czf', archive, '-C', repository, 'dsh-plugin-0123456789abcdef0123456789abcdef01234567'], { timeout: 30000 })
        const staging = await mkdtemp(join(root, 'source-staging-'))
        return { archive, staging }
      }
      const github = {
        ...manifest,
        name: '@example/github-plugin',
        version: '0.1.15-settings.4',
        exports: { '.': './index.js', './client': './lib/client.js' },
        files: ['index.js', 'lib', 'cordis.patch.yml'],
        scripts,
      }
      const built = await source(github)
      const packed = await packer.pack(built.archive, built.staging, new AbortController().signal)
      expect(packed).toMatchObject({ packageName: github.name, version: github.version })
      expect(await readdir(dirname(packed.archive))).toEqual([basename(packed.archive)])
      const listed = (await execFileText('tar', ['-tzf', packed.archive], { timeout: 30000 })).trim().split('\n').sort()
      // npm always includes the README; docs/notes.md stays out because it is not in the declared files list.
      expect(listed).toEqual(['package/README.md', 'package/cordis.patch.yml', 'package/index.js', 'package/lib/client.js', 'package/package.json'])
      const admitted = await uploads.accept('github.tgz', createReadStream(packed.archive), new AbortController().signal)
      const githubPrepared = await preparer.prepare(
        { ...admitted, upload: { archive: admitted.archive, integrity: admitted.integrity } },
        async () => {},
        new AbortController().signal,
      )
      expect(githubPrepared).toMatchObject({ packageName: github.name, version: github.version, integrity: admitted.integrity })
      const unbuilt = await source({ ...github, exports: { '.': './index.js', './client': './dist/client.js' } })
      await expect(packer.pack(unbuilt.archive, unbuilt.staging, new AbortController().signal)).rejects.toMatchObject({ code: 'plugin-build-required' })
      const linked = await source({ ...github, dependencies: { helper: 'github:example/helper' } })
      await expect(packer.pack(linked.archive, linked.staging, new AbortController().signal)).rejects.toMatchObject({ code: 'plugin-dependency-invalid' })
      // Highly compressible content expands only inside the bounded tmpfs and leaves nothing on the platform disk.
      await execFileText('dd', ['if=/dev/zero', `of=${join(top, 'zeros.bin')}`, 'bs=1M', 'count=1200'], { timeout: 120000 })
      const expanded = await source(github)
      await rm(join(top, 'zeros.bin'))
      await expect(packer.pack(expanded.archive, expanded.staging, new AbortController().signal)).rejects.toMatchObject({ code: 'plugin-package-invalid' })
      expect(await readdir(expanded.staging)).toEqual(['output'])
      expect(await readdir(join(expanded.staging, 'output'))).toEqual([])
      await expect(stat(sentinel)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await preparer.recover()
      await removeCommunityFixture(root)
      await rm(sentinel, { force: true })
    }
  },
  360000,
)
