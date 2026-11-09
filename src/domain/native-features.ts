export type NativeFeatureCopy = Readonly<Record<'en' | 'zh-CN', string>>
export interface NativeFeatureConstraint {
  readonly kind: 'at-least-one'
  readonly group: string
}
export interface NativeFeatureDefinition {
  readonly id: string
  readonly section: { readonly id: string; readonly name: NativeFeatureCopy }
  readonly name: NativeFeatureCopy
  readonly description: NativeFeatureCopy
  readonly constraints: readonly NativeFeatureConstraint[]
  readonly seam: NativeFeatureCopy
  readonly availability: { readonly available: true } | { readonly available: false; readonly reason: NativeFeatureCopy }
}
export interface NativeFeatureView extends NativeFeatureDefinition {
  readonly enabled: boolean
}

const terminal: NativeFeatureDefinition = {
  id: 'terminal',
  section: { id: 'plugins-terminal', name: { en: 'Plugins and terminal', 'zh-CN': '插件与终端' } },
  name: { en: 'Manual terminal access', 'zh-CN': '手动打开终端' },
  description: {
    en: 'When off: hides the terminal sidebar and blocks manual terminals. Agent commands and platform execution stay available.',
    'zh-CN': '取消后：隐藏终端侧栏，不能手动打开终端。Agent 执行命令和平台代执行不受影响。',
  },
  constraints: [],
  seam: { en: 'Native user terminal controls and sidebar entries', 'zh-CN': '原生用户终端控制与侧栏入口' },
  availability: { available: true },
}

const pluginInstall: NativeFeatureDefinition = {
  id: 'plugin-install',
  section: terminal.section,
  name: { en: 'Add plugins', 'zh-CN': '自行添加插件' },
  description: {
    en: 'When off: members cannot install plugins or first enable optional bundles from the native plugin page. Platform App Center installs stay available.',
    'zh-CN': '取消后：成员不能从原生插件页安装插件或首次启用官方可选包。平台应用中心安装不受影响。',
  },
  constraints: [],
  seam: { en: 'Native plugin manager and Creator installation tools', 'zh-CN': '原生插件管理与创造模式安装工具' },
  availability: { available: true },
}

export const BUILTIN_NATIVE_PRESET_IDS = Object.freeze(['standard', 'ptc', 'minimal', 'cordis'] as const)
const presetNames: Readonly<Record<(typeof BUILTIN_NATIVE_PRESET_IDS)[number], NativeFeatureCopy>> = {
  standard: { en: 'Standard', 'zh-CN': '标准' },
  ptc: { en: 'PTC', 'zh-CN': 'PTC' },
  minimal: { en: 'Minimal', 'zh-CN': '极简' },
  cordis: { en: 'Creator', 'zh-CN': '创造' },
}
const builtinPresets: readonly NativeFeatureDefinition[] = BUILTIN_NATIVE_PRESET_IDS.map(id => ({
  id: `preset-${id}`,
  section: { id: 'builtin-presets', name: { en: 'DSH built-in Agent presets', 'zh-CN': 'DSH 内置 Agent 预设' } },
  name: presetNames[id],
  description: {
    en: `When off: new sessions cannot use the ${presetNames[id].en} preset, and its existing sessions cannot resume after a restart.`,
    'zh-CN': `取消后：不能用${presetNames[id]['zh-CN']}预设新建会话，重启后它的旧会话也无法恢复，重新开启后可恢复。`,
  },
  constraints: [{ kind: 'at-least-one', group: 'builtin-presets' }],
  seam: { en: 'Native Agent preset declarations and default selection', 'zh-CN': '原生 Agent 预设声明与默认选择' },
  availability: { available: true },
}))

/** Registered once by composition; groups persist only deviations from these defaults. */
export function nativeFeatureCatalog(additions: readonly NativeFeatureDefinition[] = []): readonly NativeFeatureDefinition[] {
  const definitions = structuredClone([terminal, pluginInstall, ...builtinPresets, ...additions])
  const ids = new Set<string>()
  for (const definition of definitions) {
    if (!/^[a-z][a-z0-9-]{0,79}$/u.test(definition.id) || ids.has(definition.id)) throw new TypeError('Invalid or duplicate native feature id')
    ids.add(definition.id)
  }
  return immutable(definitions)
}
export function nativeFeatureView(catalog: readonly NativeFeatureDefinition[], disabledIds: readonly string[]): readonly NativeFeatureView[] {
  const disabled = new Set(disabledIds)
  return catalog.map(feature => ({ ...feature, enabled: !disabled.has(feature.id) }))
}

/** Unsupported and unregistered facts survive edits but cannot affect this invocation. */
export function effectiveDisabledNativeFeatures(catalog: readonly NativeFeatureDefinition[], disabledIds: readonly string[]): readonly string[] {
  const disabled = new Set(disabledIds)
  return catalog
    .filter(feature => feature.availability.available && disabled.has(feature.id))
    .map(feature => feature.id)
    .sort()
}
export function mergeNativeFeatureSelection(
  catalog: readonly NativeFeatureDefinition[],
  previous: readonly string[],
  requested: readonly string[],
): readonly string[] {
  const editable = new Set(catalog.filter(feature => feature.availability.available).map(feature => feature.id))
  if (requested.some(id => !editable.has(id)))
    throw new BusinessRuleError('invalid', 'Review the available native features and try again.', 'native-features-invalid')
  const disabled = new Set([...previous.filter(id => !editable.has(id)), ...requested])
  if (requiredGroups(catalog).some(group => [...group].every(id => disabled.has(id))))
    throw new BusinessRuleError('invalid', 'Keep at least one option enabled in each required section.', 'native-features-required')
  return [...disabled].sort()
}

/** Draft controls and persisted selections apply the same constraint to supported entries. */
export function nativeFeatureCanBeDisabled(catalog: readonly NativeFeatureDefinition[], disabledIds: readonly string[], id: string): boolean {
  if (!catalog.some(feature => feature.id === id && feature.availability.available)) return false
  const disabled = new Set(disabledIds)
  return requiredGroups(catalog).every(group => !group.has(id) || [...group].some(other => other !== id && !disabled.has(other)))
}

function requiredGroups(catalog: readonly NativeFeatureDefinition[]): readonly ReadonlySet<string>[] {
  const groups = new Map<string, Set<string>>()
  for (const feature of catalog) {
    if (!feature.availability.available) continue
    for (const constraint of feature.constraints) {
      const group = groups.get(constraint.group) ?? new Set<string>()
      group.add(feature.id)
      groups.set(constraint.group, group)
    }
  }
  return [...groups.values()]
}

function immutable<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) immutable(child)
    Object.freeze(value)
  }
  return value
}
import { BusinessRuleError } from './business-error.js'
