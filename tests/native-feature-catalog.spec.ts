import { expect, it } from 'vitest'
import {
  effectiveDisabledNativeFeatures,
  mergeNativeFeatureSelection,
  nativeFeatureCanBeDisabled,
  nativeFeatureCatalog,
  nativeFeatureView,
  type NativeFeatureDefinition,
} from '../src/domain/native-features.js'

it('keeps manual terminal access enabled when a group has no stored selection', () => {
  const terminal = nativeFeatureView(nativeFeatureCatalog(), []).find(feature => feature.id === 'terminal')
  expect(terminal).toMatchObject({
    id: 'terminal',
    enabled: true,
    name: { en: 'Manual terminal access', 'zh-CN': '手动打开终端' },
    availability: { available: true },
  })
})

it('keeps one supported option in a constrained group and never counts an unavailable option', () => {
  const constraints: NativeFeatureDefinition['constraints'] = [{ kind: 'at-least-one', group: 'mode-options' }]
  const first = { ...extension(), id: 'mode-one', constraints }
  const second = { ...extension(), id: 'mode-two', constraints }
  const catalog = nativeFeatureCatalog([first, second])
  expect(mergeNativeFeatureSelection(catalog, [], [first.id])).toEqual([first.id])
  expect(nativeFeatureCanBeDisabled(catalog, [first.id], second.id)).toBe(false)
  expect(() => mergeNativeFeatureSelection(catalog, [], [first.id, second.id])).toThrow(expect.objectContaining({ code: 'native-features-required' }))
  const unsupported = { ...second, availability: extension({ available: false, reason: { en: 'Unavailable', 'zh-CN': '不可用' } }).availability }
  expect(() => mergeNativeFeatureSelection(nativeFeatureCatalog([first, unsupported]), [], [first.id])).toThrow(
    expect.objectContaining({ code: 'native-features-required' }),
  )
  expect(nativeFeatureCanBeDisabled(catalog, [], 'terminal')).toBe(true)
})

it('preserves unknown and unavailable selections while editing only currently supported features', () => {
  const extra = extension({ available: false, reason: { en: 'Runtime unavailable', 'zh-CN': '运行时不可用' } })
  const catalog = nativeFeatureCatalog([extra])
  const previous = ['terminal', 'retired-feature', extra.id]
  const saved = mergeNativeFeatureSelection(catalog, previous, [])
  expect(saved).toEqual([extra.id, 'retired-feature'])
  expect(effectiveDisabledNativeFeatures(catalog, previous)).toEqual(['terminal'])
  expect(nativeFeatureView(catalog, saved).find(feature => feature.id === 'terminal')?.enabled).toBe(true)
  expect(previous).toEqual(['terminal', 'retired-feature', extra.id])
  for (const id of ['retired-feature', extra.id])
    expect(() => mergeNativeFeatureSelection(catalog, previous, [id])).toThrow(expect.objectContaining({ code: 'native-features-invalid' }))
})

function extension(availability: NativeFeatureDefinition['availability'] = { available: true }) {
  return {
    ...nativeFeatureCatalog()[0]!,
    id: 'future-feature',
    name: { en: 'Future feature', 'zh-CN': '后续功能' },
    availability,
  }
}

it('captures build-time additions and explains unavailable features without accepting later mutations', () => {
  const extra = extension({ available: false, reason: { en: 'Not supported by this runtime', 'zh-CN': '当前运行时不支持' } })
  const catalog = nativeFeatureCatalog([extra])
  extra.name.en = 'Changed after startup'
  expect(nativeFeatureView(catalog, []).find(feature => feature.id === extra.id)).toMatchObject({
    enabled: true,
    name: { en: 'Future feature' },
    availability: { available: false, reason: { 'zh-CN': '当前运行时不支持' } },
  })
  expect(() => nativeFeatureCatalog([nativeFeatureCatalog()[0]!])).toThrow()
})

it('offers all four builtin presets by default and refuses to remove the last one while unrelated features remain enabled', () => {
  const catalog = nativeFeatureCatalog()
  const presets = nativeFeatureView(catalog, []).filter(feature => feature.section.id === 'builtin-presets')
  expect(presets.map(feature => ({ id: feature.id, enabled: feature.enabled }))).toEqual([
    { id: 'preset-standard', enabled: true },
    { id: 'preset-ptc', enabled: true },
    { id: 'preset-minimal', enabled: true },
    { id: 'preset-cordis', enabled: true },
  ])
  const firstThree = ['preset-standard', 'preset-ptc', 'preset-minimal']
  expect(mergeNativeFeatureSelection(catalog, [], firstThree)).toEqual([...firstThree].sort())
  expect(nativeFeatureCanBeDisabled(catalog, firstThree, 'preset-cordis')).toBe(false)
  expect(() => mergeNativeFeatureSelection(catalog, [], [...firstThree, 'preset-cordis'])).toThrow(
    expect.objectContaining({ code: 'native-features-required' }),
  )
  expect(nativeFeatureCanBeDisabled(catalog, ['preset-standard', 'preset-ptc'], 'preset-cordis')).toBe(true)
})

it('offers native self-installation by default without constraining ordinary management of existing copies', () => {
  expect(nativeFeatureView(nativeFeatureCatalog(), []).find(row => row.id === 'plugin-install')).toMatchObject({
    enabled: true,
    constraints: [],
    availability: { available: true },
    name: { en: 'Add plugins', 'zh-CN': '自行添加插件' },
  })
  expect(mergeNativeFeatureSelection(nativeFeatureCatalog(), [], ['plugin-install'])).toEqual(['plugin-install'])
})
