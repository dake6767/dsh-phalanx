export declare function trackedEvidenceInputs(root: string): {
  readonly productDigest: string
  readonly runnerDigest: string
  readonly sharedTestDigest: string
  readonly tests: Readonly<Record<string, string>>
}
