import type {
  RuntimeDependencyDefinition,
  RuntimeDependency,
  RuntimeDependencyReference,
  RuntimeDependencyVersion,
  RuntimeDependencyCheck,
  PreparedBrowserBuild,
} from '../domain/runtime-dependency.js'
import type { InstalledNativeResourceBinding } from '../domain/plugin-preinstall.js'

export interface RuntimeDependencyStorePort {
  list(): Promise<readonly RuntimeDependency[]>
  save(row: RuntimeDependency): Promise<void>
  remove(name: string): Promise<void>
}
/** Explicit committed facts used only by synchronous readiness and lease fences. */
export interface RuntimeDependencyView {
  list(): readonly RuntimeDependency[]
  version(): string
}
export interface RuntimeDependencyStoragePort extends RuntimeDependencyStorePort {
  readonly view: RuntimeDependencyView
}
export type PreparedBrowserDirectories = (directory: string) => Promise<readonly string[]>

export interface BrowserDependencyConsumer {
  readonly name: string
  readonly build?: string
  readonly playwrightVersion?: string
  readonly memberCopies?: number
}

export interface RuntimeDependencyReferencesPort {
  retained?(): Promise<readonly string[]>
  list(name: string): Promise<readonly RuntimeDependencyReference[]>
  browserConsumers?(name: string): Promise<readonly BrowserDependencyConsumer[]>
  retainedBrowserBindings?(): Promise<readonly InstalledNativeResourceBinding[]>
}
export interface RuntimeDependencyPreparerPort {
  readonly isolated: boolean
  recover(): Promise<void>
  identity(input: RuntimeDependencyDefinition): string
  browserBuilds?(version: RuntimeDependencyVersion): Promise<readonly PreparedBrowserBuild[]>
  prepare(
    input: RuntimeDependencyDefinition,
    progress: (log: string, checks?: readonly RuntimeDependencyCheck[]) => Promise<void>,
    signal: AbortSignal,
  ): Promise<RuntimeDependencyVersion>
  collect(retained: readonly string[]): Promise<void>
}
