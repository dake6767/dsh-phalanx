/** Execution belongs to an opaque owner; the runner does not depend on a skill library. */
export interface ExecutionOwner { readonly id: string, readonly version: string, readonly preparationApproval?: string }
export interface ExecutionConfiguration {
  readonly contributionReceipt?: { readonly id: string, readonly revision: string, readonly warning?: string }
  readonly awaitingPreparation?: boolean
  readonly approvedContribution?: string
  readonly enabled: boolean
  readonly commands: readonly { readonly command: string, readonly blocked: readonly string[] }[]
  readonly variables: readonly { readonly name: string, readonly value: string, readonly secret: boolean }[]
  readonly prepare?: string
}
export function executionPreparationApproved(owner: ExecutionOwner, configuration: ExecutionConfiguration): boolean {
  return !configuration.awaitingPreparation && (!owner.preparationApproval || configuration.approvedContribution === owner.preparationApproval)
}
export interface ExecutionRequest {
  readonly username: string
  readonly owner: string
  readonly command: string
  readonly argv: readonly string[]
  readonly cwd: string
  readonly stdin: Uint8Array
}
export interface ExecutionEvent { readonly stream: 'stdout' | 'stderr', readonly data: Uint8Array }
export type ExecutionFailureCode = 'unauthorized' | 'disabled' | 'not-ready' | 'command-missing' | 'concurrency' | 'timeout' | 'invalid-directory' | 'development-failed' | 'internal' | 'idle-reclaimed' | 'process-exited' | 'upstream-error'
export const EXECUTION_UNAVAILABLE_EXIT = 125
const reasons: Record<ExecutionFailureCode, readonly [string, string]> = {
  unauthorized: ['Not authorized', '未授权'], disabled: ['Execution is disabled', '代执行已关闭'],
  'not-ready': ['Dependencies are not ready', '依赖未就绪'], 'command-missing': ['Command is unavailable', '命令不可用'],
  concurrency: ['Concurrency limit reached', '超过并发限制'], timeout: ['Execution timed out', '执行超时'],
  'invalid-directory': ['Working directory is outside your space', '工作目录不在成员空间内'],
  'development-failed': ['Development execution failed', '开发模式执行失败'], internal: ['Platform is unavailable', '平台不可用'],
  'idle-reclaimed': ['Idle MCP carrier reclaimed', '空闲 MCP 进程已回收'],
  'process-exited': ['MCP process exited', 'MCP 子进程已退出'],
  'upstream-error': ['MCP upstream returned an error', 'MCP 上游返回错误'],
}
export class ExecutionFailure extends Error {
  constructor(readonly code: ExecutionFailureCode) { super(`DSH_PHALANX_EXECUTION[${code}]: ${reasons[code][0]} / ${reasons[code][1]}. Contact an administrator / 请联系管理员。`) }
}
export const EXECUTION_CREDENTIAL_NOTICE = 'API Key: Credentials are configured by the platform / 凭据由平台配置。\n'
