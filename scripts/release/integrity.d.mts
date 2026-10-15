export const imageName: string
export const candidatePattern: RegExp
export function assetNamesFor(platform: 'linux/amd64' | 'linux/arm64'): string[]
export const assetNames: string[]
export function sha256(data: string | Buffer): string
export function fileHash(path: string): Promise<string>
export function validateManifest<T>(manifest: T, expected?: { tag?: string; commit?: string; platform?: 'linux/amd64' | 'linux/arm64' }): T
export function verifyDirectory(directory: string, expected?: { tag?: string; commit?: string; platform?: 'linux/amd64' | 'linux/arm64' }): Promise<unknown>
export function requireSuccessfulJobs(results: Record<string, { result: string }>): void
export function validateAcceptance(acceptance: unknown, manifest: unknown, summaryHash: string): void
