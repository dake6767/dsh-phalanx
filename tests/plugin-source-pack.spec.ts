import { expect, it } from 'vitest'
import { decodePluginSource, samePluginSource } from '../src/domain/plugin-library.js'
import { pluginSourceRequest } from '../src/domain/plugin-intake.js'
import { declaredPluginEntries } from '../src/dsh/plugin-source-pack.js'

it('lists the bundle patch, main and every concrete export target that packing must contain', () => {
  expect(
    declaredPluginEntries({
      main: './src/index.js',
      exports: {
        '.': { import: './src/index.js', default: './lib/index.cjs' },
        './client': ['./lib/client.js'],
        './assets/*': './assets/*',
        './private': null,
      },
      dsh: { bundle: { patch: './cordis.patch.yml' } },
    }),
  ).toEqual(['cordis.patch.yml', 'src/index.js', 'lib/client.js', 'lib/index.cjs'])
  expect(declaredPluginEntries({ main: './index.js' })).toBeUndefined()
  expect(declaredPluginEntries({ exports: '../outside.js', dsh: { bundle: { patch: './patch.yml' } } })).toBeUndefined()
  expect(declaredPluginEntries({ main: 7, dsh: { bundle: { patch: './patch.yml' } } })).toBeUndefined()
})

it('treats GitHub repository spellings as one source and reads only exact stored GitHub facts', () => {
  expect(samePluginSource({ kind: 'github', repository: 'Owner/Repo' }, { kind: 'github', repository: 'owner/repo' })).toBe(true)
  expect(samePluginSource({ kind: 'github', repository: 'owner/repo' }, { kind: 'github', repository: 'owner/fork' })).toBe(false)
  expect(samePluginSource({ kind: 'github', repository: 'owner/repo' }, { kind: 'npm' })).toBe(false)
  expect(decodePluginSource({ kind: 'github', repository: 'owner/repo.js' })).toEqual({ kind: 'github', repository: 'owner/repo.js' })
  for (const value of [
    { kind: 'github', repository: 'owner/repo.git' },
    { kind: 'github', repository: 'owner' },
    { kind: 'github', repository: 7 },
  ])
    expect(() => decodePluginSource(value)).toThrow('Invalid stored plugin source')
  expect(pluginSourceRequest(' github:owner/repo ')).toEqual({ kind: 'github', repository: 'owner/repo' })
  expect(pluginSourceRequest('https://github.com/owner/repo/')).toEqual({ kind: 'github', repository: 'owner/repo' })
  expect(pluginSourceRequest('@scope/plugin')).toEqual({ kind: 'npm', packageName: '@scope/plugin', version: 'latest' })
})

async function packDirectory(prepare: (top: string) => Promise<void>) {
  const { mkdir, mkdtemp, rm, writeFile } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { execFileText } = await import('../src/adapters/runtime-command.js')
  const { hostPluginSourcePacker } = await import('./support/plugin-github.js')
  const root = await mkdtemp(join(tmpdir(), 'plugin-source-pack-'))
  try {
    const top = join(root, 'repo', 'repo-0000000000000000000000000000000000000000')
    await mkdir(top, { recursive: true })
    await writeFile(
      join(top, 'package.json'),
      JSON.stringify({ name: 'packed', version: '1.0.0', main: './index.js', dsh: { bundle: { patch: './patch.yml' } } }),
    )
    await writeFile(join(top, 'index.js'), 'export {}')
    await writeFile(join(top, 'patch.yml'), '[]')
    await prepare(top)
    await execFileText('tar', ['-czf', join(root, 'source.tar.gz'), '-C', join(root, 'repo'), 'repo-0000000000000000000000000000000000000000'], {
      timeout: 30_000,
    })
    const work = join(root, 'work')
    await mkdir(work)
    return await hostPluginSourcePacker.pack(join(root, 'source.tar.gz'), work, new AbortController().signal).then(
      value => ({ ok: true as const, value }),
      (error: { code?: string }) => ({ ok: false as const, code: error.code }),
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

it('refuses links and too many files, and a repository npm configuration cannot change packing', async () => {
  const { symlink, writeFile, mkdir } = await import('node:fs/promises')
  const { join } = await import('node:path')
  expect(await packDirectory(async () => {})).toMatchObject({ ok: true, value: { packageName: 'packed', version: '1.0.0' } })
  expect(await packDirectory(top => symlink('/etc/hosts', join(top, 'hosts')))).toEqual({ ok: false, code: 'plugin-package-invalid' })
  expect(
    await packDirectory(async top => {
      await mkdir(join(top, 'many'))
      await Promise.all(Array.from({ length: 20_001 }, (_, index) => writeFile(join(top, 'many', `${index}`), '')))
    }),
  ).toEqual({ ok: false, code: 'plugin-package-invalid' })
  // npm reads project configuration from the scratch working directory, never the repository; the script also deletes the repository .npmrc.
  // This pins the observable contract: a repository .npmrc cannot redirect the archive or re-enable scripts.
  expect(
    await packDirectory(async top => {
      await writeFile(join(top, '.npmrc'), 'pack-destination=/tmp\nignore-scripts=false\n')
    }),
  ).toMatchObject({ ok: true, value: { packageName: 'packed' } })
}, 120_000)
