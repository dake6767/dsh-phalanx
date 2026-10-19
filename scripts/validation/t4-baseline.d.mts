export const VALIDATOR_USER: string
export const GUEST_SERVICE_PORT: number
export const MEMORY_FLOOR_MIB: number
export const PREPARE_DISK_GIB: number
export const STAGE_DISK_GIB: number
export const ISO_TOOLS: readonly string[]
export const PRESETS: readonly string[]
export const QEMU_HOST_ADDRESS: string
export interface BaselineReceipt {
  readonly schema: 1
  readonly tag: string
  readonly commit: string
  readonly preset?: string
  readonly harness?: { readonly commit: string; readonly scriptSha256: string }
  readonly ubuntu: { readonly image: string; readonly sha256: string }
  readonly platformSha256?: string
  readonly imageDigest?: string
  readonly installSeconds: number
  readonly exitCode: number | null
  readonly base?: { readonly path: string; readonly sha256: string; readonly bytes: number; readonly virtualGib?: number }
  readonly createdUtc?: string
}
type Forward = { readonly guest: number; readonly host: number }
export function parseBaselineReceipt(value: unknown): BaselineReceipt
export function verifyBaseline(receipt: unknown, actualBaseSha256: string): { readonly ok: boolean; readonly expected: string | undefined; readonly actual: string; readonly reinstall: boolean }
export function cloudInitSeed(config: { readonly instanceId: string; readonly publicKey: string; readonly user?: string }): { readonly 'user-data': string; readonly 'meta-data': string }
export function instanceIdFor(kind: 'prepare' | 'stage', label: string, suffix?: string): string
export function resolveIsoTool(available: readonly string[]): string | undefined
export function seedCommand(tool: string, seedPath: string): string[]
export function overlayCreateArgs(base: string, overlay: string): string[]
export function qemuArgs(config: { readonly overlay: string; readonly seed: string; readonly sshPort: number; readonly memoryMib?: number; readonly processors?: number; readonly forwards?: readonly Forward[]; readonly pidFile: string; readonly serialLog: string }): string[]
export function formalInstallCommand(installer: string, tag: string, preset?: string): string
export function installIdentity(output: { readonly status?: string; readonly changed?: boolean; readonly commit?: string; readonly platformSha256?: string; readonly imageDigest?: string }, record: { readonly commit: string; readonly platformSha256: string; readonly imageDigest: string }): { readonly commit: string; readonly platformSha256: string; readonly imageDigest: string }
export function resealCommands(user?: string): string[]
export function resealScript(user?: string): string
export function serviceReadyCommand(timeoutSeconds?: number): string
export function availableMemoryMib(meminfo: string): number
export function availableDiskGib(filesystem: { readonly bsize: number; readonly bavail: number }): number
export function storePaths(store: string, tag: string): { readonly base: string; readonly receipt: string }
export function parseCli(argv: readonly string[]): { readonly command: 'prepare' | 'stage' | 'end' | 'verify'; readonly options: Record<string, unknown> & { readonly forwards: readonly Forward[] } }
export function sshArgs(key: string, port: number): string[]
export function parsePid(text: string, source: string): number
export function claimSingleVm(store: string): void
export function releaseVm(store: string, owners: readonly (number | undefined)[]): void
export function ownsVm(cmdline: string, overlay: string): boolean
export function waitVmExit(pidFile: string, timeoutMs: number, pollMs?: number): Promise<void>
export function makeSeed(workDir: string, instanceId: string, publicKey: string): Promise<string>
export function bootVm(options: { readonly overlay: string; readonly seed: string; readonly workDir: string; readonly sshPort: number; readonly forwards: readonly Forward[]; readonly memoryMib: number }): { readonly pidFile: string; readonly serialLog: string }
export function memoryFloorMib(guestMib?: number): number
