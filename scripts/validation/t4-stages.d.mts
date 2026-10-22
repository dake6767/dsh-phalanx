export interface StageTable {
  readonly schema: 1
  readonly fieldFiles: readonly string[]
  readonly versionMetadata: readonly string[]
  readonly harness: readonly string[]
  readonly stageHarness: Readonly<Record<string, readonly string[]>>
  readonly noStage: readonly string[]
  readonly allStages: readonly string[]
  readonly stages: readonly { readonly id: string; readonly title: string; readonly always?: boolean; readonly deliverableOnly?: boolean; readonly entries: readonly string[]; readonly paths: readonly string[] }[]
}
export type ChangeKind = 'versionMetadata' | 'harness' | 'harnessUnused' | 'noStage' | 'buildInput' | 'deliverable' | 'unlisted'
export interface StageChange { readonly path: string; readonly fields?: readonly string[] }
export interface StageReason { readonly path: string; readonly kind: 'harness' | 'buildInput' | 'deliverable' | 'unlisted'; readonly pattern?: string; readonly fields?: readonly string[] }
export interface StageResult {
  readonly unlisted: string[]
  readonly changes: (StageChange & { readonly kind: ChangeKind })[]
  readonly stages: { readonly id: string; readonly title: string; readonly always: boolean; run: boolean; readonly reasons: StageReason[] }[]
}
export function changedFields(before: unknown, after: unknown, prefix?: string): string[]
export function classifyStages(changes: readonly StageChange[], table: StageTable, closures?: Readonly<Record<string, readonly string[]>>): StageResult
export function importClosure(entries: readonly string[], commit: string, root?: string): string[]
export function diffChanges(base: string, head: string, table: StageTable, root?: string): StageChange[]
