/** Member choices belong to immutable space identities, never the writable DSH profile. */
export interface PluginSelectionsPort {
  get(spaceId: string): readonly string[]
  set(spaceId: string, packages: readonly string[]): void
  members(packageName: string): readonly string[]
  removePackage(packageName: string): void
  retainPackages(packageNames: readonly string[]): void
}
