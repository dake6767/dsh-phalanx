import { join, resolve } from 'node:path'

export function durableStorageRoot(dataRoot: string): string {
  return resolve(dataRoot) + '.durable'
}

/** Durable defaults have a separate namespace for each rebuildable platform root. */
export function effectiveUserDataRoot(config: { readonly dataRoot: string; readonly userDataRoot?: string }): string {
  return resolve(config.userDataRoot ?? join(durableStorageRoot(config.dataRoot), 'users'))
}
