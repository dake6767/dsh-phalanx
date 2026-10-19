export interface StageTable {
  readonly schema: 1
  readonly fieldFiles: readonly string[]
  readonly versionMetadata: readonly string[]
  readonly harness: readonly string[]
  readonly noStage: readonly string[]
  readonly stages: readonly { readonly id: string, readonly title: string, readonly always?: boolean, readonly entries: readonly string[], readonly paths: readonly string[] }[]
}
export interface StageChange { readonly path: string, readonly fields?: readonly string[] }
export interface StageReason { readonly path: string, readonly kind: 'deliverable' | 'harness' | 'unlisted', readonly pattern?: string, readonly fields?: readonly string[] }
export interface StageResult {
  readonly unlisted: string[]
  readonly stages: { readonly id: string, readonly title: string, readonly always: boolean, run: boolean, readonly reasons: StageReason[] }[]
}
export function changedFields(before: unknown, after: unknown, prefix?: string): string[]
export function classifyStages(changes: readonly StageChange[], table: StageTable, closures?: Readonly<Record<string, readonly string[]>>): StageResult
export function importClosure(entries: readonly string[], commit: string, root?: string): string[]
export function diffChanges(base: string, head: string, table: StageTable, root?: string): StageChange[]
