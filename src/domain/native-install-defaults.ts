import { createHash } from 'node:crypto'
import { canonicalJson } from './suite-catalog-document.js'
import type { PreparedPlugin } from './plugin-library.js'
import { literalPluginAccess } from './plugin-config-data.js'
import { pluginAccessObject, type PluginEntryConfig } from './plugin-access.js'

export type NativeInstallDefaults = Readonly<Record<string, PluginEntryConfig>>

export function readNativeInstallDefaults(value: unknown): NativeInstallDefaults | undefined {
  if (!pluginAccessObject(value)) return
  try {
    const entries = Object.entries(value)
    if (!entries.length || entries.length > 64 || Buffer.byteLength(JSON.stringify(value), 'utf8') > 32 * 1024) return
    if (entries.some(([id, config]) => !/^[A-Za-z0-9._-]{1,128}$/u.test(id) || !pluginAccessObject(config) || !literalPluginAccess(config))) return
    return Object.fromEntries(entries) as NativeInstallDefaults
  } catch {
    return
  }
}

export function matchesPendingInstallDefaults(
  prepared: Pick<PreparedPlugin, 'version' | 'integrity' | 'installDefaults'>,
  installed: { readonly version?: string; readonly archiveIntegrity?: string; readonly installDefaultsPending?: string },
): boolean {
  return (
    !!prepared.installDefaults &&
    prepared.version === installed.version &&
    prepared.integrity === installed.archiveIntegrity &&
    installed.installDefaultsPending === createHash('sha256').update(canonicalJson(prepared.installDefaults)).digest('hex')
  )
}
