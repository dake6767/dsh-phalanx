import { join } from 'node:path'
import { nativeTerminalAccessModule } from './native-terminal-access.js'
import { BUILTIN_NATIVE_PRESET_IDS, nativeFeatureCatalog, type NativeFeatureDefinition } from '../domain/native-features.js'
import { nativePluginPolicyOverlay, nativePluginPolicyModule, type NativePluginPolicyConfiguration } from './native-plugin-policy.js'
import { nativePresetDefaultModule } from './native-presets.js'
import { nativePresetClientEntry, nativePresetClientFiles } from './native-preset-client.js'

export interface DshNativeFeatureRegistration {
  readonly feature: NativeFeatureDefinition
  readonly entries: readonly string[]
}
export interface NativeFeaturePatch {
  readonly id: string
  readonly disabled: true
}

export interface DshNativeFeatures {
  readonly catalog: readonly NativeFeatureDefinition[]
  patch(disabledIds: readonly string[]): readonly NativeFeaturePatch[]
}

/** Build-time official entry bindings; groups never supply native entry names. */
export function dshNativeFeatures(additions: readonly DshNativeFeatureRegistration[] = []): DshNativeFeatures {
  const registrations = structuredClone(additions)
  const catalog = nativeFeatureCatalog(registrations.map(item => item.feature))
  for (const registration of registrations)
    if (registration.feature.availability.available && !registration.entries.length) throw new TypeError('Available native features require entry bindings')
  const entries = new Map<string, readonly string[]>([
    ['plugin-install', ['tool-plugin-manager', 'tool-plugin-market']],
    ['terminal', ['terminal-controller', 'ui-sidebar-terminal']],
    ...BUILTIN_NATIVE_PRESET_IDS.map(id => [`preset-${id}`, [`preset-${id}`]] as const),
    ...registrations.map(item => [item.feature.id, item.entries] as const),
  ])
  return {
    catalog,
    patch: disabledIds => {
      const disabled = new Set(disabledIds)
      const ids = new Set(
        catalog.filter(feature => feature.availability.available && disabled.has(feature.id)).flatMap(feature => entries.get(feature.id) ?? []),
      )
      const patch: NativeFeaturePatch[] = [...ids].map(id => ({ id, disabled: true }))
      return patch.concat(nativePluginPolicyOverlay.map(({ id }) => ({ id, disabled: true as const })))
    },
  }
}

export function nativeFeatureProjection(
  patch: readonly NativeFeaturePatch[],
  directory: string,
  policy?: NativePluginPolicyConfiguration,
): {
  readonly patch: readonly unknown[]
  readonly files: Readonly<Record<string, string>>
} {
  const files: Record<string, string> = {}
  const entries: { readonly id: string; readonly name: string }[] = []
  if (policy) {
    files['plugin-policy.mjs'] = nativePluginPolicyModule(policy)
    entries.push({ id: 'phalanx-native-plugin-policy', name: join(directory, 'plugin-policy.mjs') })
  }
  if (patch.some(row => row.id === 'terminal-controller')) {
    files['terminal-access.mjs'] = nativeTerminalAccessModule
    entries.push({ id: 'phalanx-native-terminal-access', name: join(directory, 'terminal-access.mjs') })
  }
  if (patch.some(row => BUILTIN_NATIVE_PRESET_IDS.some(id => row.id === 'preset-' + id))) {
    files['preset-default.mjs'] = nativePresetDefaultModule
    entries.push({ id: 'phalanx-native-preset-default', name: join(directory, 'preset-default.mjs') })
  }
  if (patch.some(row => row.id === 'preset-cordis')) {
    Object.assign(files, nativePresetClientFiles())
    entries.push({ id: 'phalanx-native-preset-controls', name: join(directory, nativePresetClientEntry) })
  }
  return {
    files,
    patch: [...(entries.length ? [{ insert: entries }, ...entries.map(({ id }) => ({ id, disabled: false }))] : []), ...patch],
  }
}

/** Creator's nested tools require a complete composed declaration, independently of its menu availability. */
export function nativePluginAccess(patch: readonly NativeFeaturePatch[]) {
  const allowInstall = !patch.some(row => row.id === 'tool-plugin-manager')
  return { allowInstall, restrictCreator: !allowInstall && !patch.some(row => row.id === 'preset-cordis') }
}
