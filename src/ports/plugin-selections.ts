/** Member choices belong to immutable space identities, never the writable DSH profile. */
export interface PluginSelectionsPort {
  get(spaceId: string): Promise<readonly string[]>
  set(spaceId: string, packages: readonly string[]): Promise<void>
  members(packageName: string): Promise<readonly string[]>
  removePackage(packageName: string): Promise<void>
  retainPackages(packageNames: readonly string[]): Promise<void>
}
