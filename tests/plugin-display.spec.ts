import { expect, it } from 'vitest'
import { resolvePluginDisplay } from '../src/domain/plugin-display.js'
import { pluginLibraryView, type LibraryPlugin } from '../src/domain/plugin-library.js'

const icon = 'data:image/svg+xml;base64,PHN2Zy8+'

it('resolves display fields independently for each platform language', () => {
  const plugin = {
    packageName: '@fixture/editor',
    title: 'Manifest title',
    description: 'Manifest description',
    meta: { title: { en: 'Package editor', zh: '包内编辑器' }, description: { en: 'Package description' }, icon },
    display: {
      catalogDefaults: { title: { en: 'Catalog editor', 'zh-CN': '广场编辑器' }, description: { en: 'Catalog description', 'zh-CN': '广场简介' } },
    },
  }
  expect(resolvePluginDisplay(plugin, 'zh-CN')).toEqual({ title: '包内编辑器', description: '广场简介', icon })
  expect(resolvePluginDisplay(plugin, 'en')).toEqual({ title: 'Package editor', description: 'Package description', icon })
  expect(resolvePluginDisplay({ ...plugin, display: { ...plugin.display, name: 'Team editor' } }, 'zh-CN')).toEqual({
    title: 'Team editor',
    description: '广场简介',
    icon,
  })
  const { display, ...withoutCatalog } = plugin
  expect(resolvePluginDisplay(withoutCatalog, 'zh-CN').description).toBe('Package description')
  expect(resolvePluginDisplay({ ...withoutCatalog, display: { ...display, catalogDefaults: {} }, meta: { title: { 'zh-cn': '简体中文' } } }, 'zh-CN')).toEqual({
    title: '简体中文',
    description: 'Manifest description',
  })
  expect(resolvePluginDisplay({ packageName: plugin.packageName, title: '', description: '' }, 'en')).toEqual({
    title: plugin.packageName,
    description: '',
  })
})

it('redacts contribution metadata before the multilingual contract reaches the browser', () => {
  const secret = 'sk-proj-fixture-for-credit-redaction-1234567890'
  const row: LibraryPlugin = {
    packageName: '@fixture/editor',
    version: '1.0.0',
    current: {
      packageName: '@fixture/editor',
      version: '1.0.0',
      integrity: 'fixture-integrity',
      artifact: 'artifacts/fixture',
      runtimeRevision: 'fixture-runtime',
      title: `Plugin ${secret}`,
      description: '',
      meta: { title: { zh: `编辑器 ${secret}` }, description: { en: `Description ${secret}` }, icon },
      bundlePatch: '',
      dependencies: {},
    },
    source: { kind: 'npm' },
    contributionReceipt: { id: 'fixture', revision: '1' },
    stage: 'available',
    published: false,
  }
  const view = pluginLibraryView(row)
  expect(JSON.stringify(view)).not.toContain(secret)
  expect(resolvePluginDisplay(view, 'zh-CN')).toMatchObject({ title: expect.stringContaining('编辑器'), icon })
  expect(resolvePluginDisplay(view, 'en').description).toContain('Description')
})
