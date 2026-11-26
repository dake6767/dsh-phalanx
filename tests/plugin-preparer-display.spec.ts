import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { ContainerPluginPreparer } from '../src/adapters/plugin-preparer.js'

it('reads only exported metadata and bounded images from a frozen plugin preparation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'phalanx-plugin-display-'))
  const plugin = {
    packageName: '@fixture/editor',
    version: '1.0.0',
    artifact: 'artifacts/fixture',
    runtimeRevision: 'fixture-runtime',
  }
  const modules = join(root, 'plugins', plugin.artifact, 'prepared', plugin.runtimeRevision, 'node_modules')
  const directory = join(modules, plugin.packageName)
  const locales = join(directory, 'locale')
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>'
  const image = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`
  const preparer = new ContainerPluginPreparer({
    command: 'node',
    args: [],
    dataRoot: root,
    defaultModel: { provider: 'fixture', model: 'fixture', upstream: { baseUrl: 'https://example.test' } },
  })
  const manifest = {
    name: plugin.packageName,
    version: plugin.version,
    description: 'x'.repeat(256 * 1024),
    exports: { './locale/*.json': { import: './locale/*.json' }, './icon': './logo.svg' },
  }
  const setIcon = (icon?: string) => writeFile(join(directory, 'package.json'), JSON.stringify({ ...manifest, icon }))
  try {
    await mkdir(locales, { recursive: true })
    await setIcon()
    await writeFile(join(locales, 'en.json'), '{"meta":{"title":"Editor","description":42}}')
    await writeFile(join(locales, 'zh-CN.json'), '{"meta":{"title":"编辑器","description":"中文简介"}}')
    await writeFile(join(locales, 'ja.json'), '{broken')
    await writeFile(join(locales, 'not_a_locale.json'), '{"meta":{"title":"Ignore filename"}}')
    await writeFile(join(locales, 'de.json'), Buffer.alloc(256 * 1024 + 1))
    await writeFile(join(directory, 'logo.svg'), svg)
    await writeFile(
      join(directory, 'preferred.png'),
      Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aP9sAAAAASUVORK5CYII=', 'base64'),
    )
    await writeFile(join(directory, 'large.svg'), Buffer.alloc(256 * 1024 + 1))
    await writeFile(join(directory, 'logo.txt'), svg)
    await writeFile(join(modules, 'outside.svg'), svg)
    await symlink(join(modules, 'outside.svg'), join(directory, 'linked.svg'))
    const expectedText = { title: { en: 'Editor', 'zh-cn': '编辑器' }, description: { 'zh-cn': '中文简介' } }
    await expect(preparer.readDisplayMetadata(plugin)).resolves.toEqual({ ...expectedText, icon: image })
    await setIcon('./preferred.png')
    await expect(preparer.readDisplayMetadata(plugin)).resolves.toMatchObject({ icon: expect.stringMatching(/^data:image\/png;base64,/u) })
    for (const invalidIcon of ['large.svg', 'logo.txt', 'linked.svg', '../../outside.svg', 'https://example.test/icon.svg']) {
      await setIcon(invalidIcon)
      await expect(preparer.readDisplayMetadata(plugin)).resolves.toEqual(expectedText)
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
