export declare const FAST_CHECK_BUDGET_MS: number
export declare const LOW_MEMORY_THRESHOLD_BYTES: number

export declare function resolveValidationMaxWorkers(envValue: string | undefined, totalMemoryBytes: number): string
export declare function resolveBrowserMaxWorkers(envValue: string | undefined): string
export declare function verifyBrowserReportCompleteness(
  report: unknown,
  expectedFiles: readonly string[],
  root: string,
): { readonly complete: boolean; readonly reason?: string }

export declare function evidenceInputDigest(
  inputs: {
    readonly productDigest: string
    readonly imageId: string
    readonly runnerDigest: string
    readonly configDigest: string
    readonly sharedTestDigest: string
    readonly tests?: Readonly<Record<string, string>>
  },
  files: readonly string[],
): string

export declare function fastCheckEvidenceDigest(inputs: {
  readonly productDigest: string
  readonly imageId: string
  readonly runnerDigest: string
  readonly configDigest: string
  readonly sharedTestDigest: string
  readonly tests?: Readonly<Record<string, string>>
}): string

export declare function fastCheckStageDigest(
  inputs: {
    readonly productDigest: string
    readonly imageId: string
    readonly runnerDigest: string
    readonly configDigest: string
    readonly sharedTestDigest: string
    readonly tests?: Readonly<Record<string, string>>
  },
  stage: string,
): string

export declare function fastCheckConfigurationDigest(settings: {
  readonly nodeVersion: string
  readonly platform: string
  readonly arch: string
  readonly maxWorkers: string
}): string

export declare function evidenceFileGroups(paths: readonly string[]): {
  readonly product: string[]
  readonly runner: string[]
  readonly sharedTests: string[]
  readonly unitTests: string[]
  readonly e2eTests: string[]
}

export declare function evidenceIndexInputs(entries: readonly { readonly mode: string; readonly oid: string; readonly path: string }[]): {
  readonly productDigest: string
  readonly runnerDigest: string
  readonly sharedTestDigest: string
  readonly tests: Record<string, string>
}
