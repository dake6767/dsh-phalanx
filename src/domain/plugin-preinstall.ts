import type { CommunityAccountActor, CommunityAccountRecord } from './community-account.js'
import type { CatalogResourceBinding } from './suite-resource-bindings.js'
import type { LibraryPlugin, PreparedPlugin } from './plugin-library.js'

export interface NativePluginDependencyPlan {
  readonly identity?: string
  readonly dependencies: readonly string[]
  readonly resources?: readonly InstalledNativeResourceBinding[]
}
export type NativePluginArchiveFacts = Readonly<Record<string, { readonly version: string; readonly integrity: string }>>
export type NativePluginDependencyPlans = Readonly<Record<string, NativePluginDependencyPlan>>

export type InstalledNativeResourceBinding = CatalogResourceBinding & { readonly runtimeDependency: string }

export function nativePluginDependencyPlan(row: LibraryPlugin): NativePluginDependencyPlan {
  return {
    identity: JSON.stringify([
      row.suiteOrigin,
      row.current?.version,
      row.current?.integrity,
      row.current?.artifact,
      row.current?.preparationId,
      row.runtimeDependencies,
      row.suiteResourceBindings,
      row.suiteResourceEnvironment,
    ]),
    dependencies: row.runtimeDependencies ?? [],
    ...(row.suiteResourceBindings ? { resources: row.suiteResourceBindings } : {}),
  }
}

export interface PluginPreinstallPlan {
  readonly actor: CommunityAccountActor
  readonly groupId: string
  readonly plugins: readonly PreparedPlugin[]
  readonly blocked?: readonly string[]
  readonly firstEntry?: readonly string[]
  readonly dependencies?: NativePluginDependencyPlans
}

/** A changed startup identity or group is cancellation, not an installation failure. */
export class PluginPreinstallCancelled extends Error {}

export interface PluginPreinstallInputs {
  readonly account: Pick<CommunityAccountRecord, 'groupId' | 'disabled'> | undefined
  readonly groupId: string
  readonly packages: readonly string[]
  readonly deliveries: readonly { readonly packageName: string }[]
  readonly installed: readonly string[]
  readonly library: readonly LibraryPlugin[]
  readonly runtimeRevision: string
}

/** Delivery history, rather than current enablement, makes preinstallation one-time. */
export function preinstallCandidates(input: PluginPreinstallInputs): readonly PreparedPlugin[] {
  if (!input.account || input.account.disabled || input.account.groupId !== input.groupId) return []
  const configured = new Set(input.packages),
    delivered = new Set(input.deliveries.map(row => row.packageName)),
    installed = new Set(input.installed)
  return input.library
    .flatMap(row =>
      configured.has(row.packageName) &&
      !delivered.has(row.packageName) &&
      !installed.has(row.packageName) &&
      !row.removing &&
      !row.incompatible &&
      row.stage === 'available' &&
      row.current?.runtimeRevision === input.runtimeRevision
        ? [row.current]
        : [],
    )
    .sort((left, right) => left.packageName.localeCompare(right.packageName))
}
