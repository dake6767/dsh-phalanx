/** Online catalog location and transport limits; the platform fetches on every gallery open. */
export const defaultSuiteCatalogAsset = 'https://github.com/dake6767/dsh-phalanx-catalog/releases/latest/download/catalog.json'
export const suiteCatalogFetchTimeoutMs = 10_000
export const suiteCatalogMaximumBytes = 2 * 1024 * 1024

/** Configured addresses are used as given; the default goes through the configured GitHub asset prefix. */
export function resolveSuiteCatalogAddress(configured: string | undefined, githubAssetsPrefix: string): string {
  return configured ?? `${githubAssetsPrefix}${defaultSuiteCatalogAsset}`
}
