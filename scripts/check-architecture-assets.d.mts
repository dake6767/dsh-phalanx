export function countCssCodeLines(source: string): number
export function countJsCodeLines(source: string): number
export function auditArchitectureAssets(base?: string): Promise<string[]>
export function auditSizeExemptions(value: unknown, exists: (file: string) => boolean): string[]
