export interface SourceTree {
  truncated: boolean
  tree: { path: string; mode: string; type: string; sha: string }[]
}
export function harnessReusePlan(before: SourceTree, after: SourceTree, blockingChecks?: string[]): { changed: string[]; checks: string[]; inputDigest: string }
export function verifyHarnessReuse(source: string, head: string, acceptance?: unknown, blockingChecks?: string[]): void
