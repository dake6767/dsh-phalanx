/** Public native plugin-manager RPC methods. */
export const DSH_BUNDLE_LIST = 'pluginManager/listBundles'
export const DSH_BUNDLE_INSTALL = 'pluginManager/installBundle'
export const DSH_BUNDLE_ENABLE = 'pluginManager/setBundleEnabled'
export const DSH_BUNDLE_UPDATE = 'pluginManager/updateBundle'
export const DSH_PLUGIN_ENABLE = 'pluginManager/setPluginEnabled'
export const DSH_BUNDLE_REMOVE = 'pluginManager/removeBundle'

/** Read only public official optional-bundle state, rejecting malformed native inventory. */
export function nativeOptionalBundles(value: unknown): readonly import('../ports/native-plugin-history.js').NativeOptionalBundle[] {
  if (!Array.isArray(value)) throw new TypeError('Native bundle inventory is unavailable')
  return value.flatMap((row: unknown) => {
    if (!row || typeof row !== 'object') throw new TypeError('Invalid native bundle inventory')
    const bundle = row as Record<string, unknown>
    if (bundle.official !== true || bundle.optional !== true) return []
    if (typeof bundle.name !== 'string' || !bundle.name || typeof bundle.enabled !== 'boolean' || typeof bundle.installed !== 'boolean')
      throw new TypeError('Invalid native optional bundle state')
    return [{ name: bundle.name, enabled: bundle.enabled, installed: bundle.installed, ...(bundle.error ? { failed: true } : {}) }]
  })
}
