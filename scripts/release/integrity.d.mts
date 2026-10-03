export const imageName: string
export const candidatePattern: RegExp
export const assetNames: string[]
export function sha256(data: string | Buffer): string
export function fileHash(path: string): Promise<string>
export function validateManifest<T>(manifest: T, expected?: { tag?: string; commit?: string }): T
export function verifyDirectory(directory: string, expected?: { tag?: string; commit?: string }): Promise<unknown>
export function requireSuccessfulJobs(results: Record<string, { result: string }>): void
export function validateAcceptance(acceptance: unknown, manifest: unknown, summaryHash: string): void
