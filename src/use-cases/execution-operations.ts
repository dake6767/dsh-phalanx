import type { CommunityAccountActor } from '../domain/community-account.js'
import { CommunityAuthenticationError } from '../domain/community-account.js'
import { BusinessRuleError } from '../domain/business-error.js'
import { executionLimits } from '../domain/execution-control.js'
import { executionCommandLine } from '../domain/execution-command-line.js'
import { EXECUTION_UNAVAILABLE_EXIT, ExecutionFailure } from '../domain/platform-execution.js'
import type { CommunityExecutionTrial, CommunityExecutionSettings, CommunityExecutionLimits, CommunityExecutionRecord } from '../domain/admin-contract.js'
import type { CommunityAccountStorePort } from '../ports/community-accounts.js'
import type { CommunityUserSpaceStoragePort } from '../ports/community-user-spaces.js'
import type { ExecutionControl } from './execution-control.js'
import type { PlatformExecution } from './platform-execution.js'

export class ExecutionOperations {
  constructor(private readonly accounts: Pick<CommunityAccountStorePort, 'get'>, private readonly control: ExecutionControl,
    private readonly execution: PlatformExecution, private readonly spaces: CommunityUserSpaceStoragePort, private readonly containerMembers: boolean, private readonly isolated: () => boolean) {}
  settings(actor: CommunityAccountActor): CommunityExecutionSettings { this.assertAdmin(actor); return { limits: this.control.limits.get(), isolated: this.isolated() } }
  save(actor: CommunityAccountActor, input: CommunityExecutionLimits): CommunityExecutionSettings { this.assertAdmin(actor); this.control.limits.save(executionLimits(input)); return this.settings(actor) }
  records(actor: CommunityAccountActor, username?: string, owner?: string): readonly CommunityExecutionRecord[] { this.assertAdmin(actor); return this.control.records(username, owner) }
  async trial(actor: CommunityAccountActor, owner: string, line: string, signal: AbortSignal): Promise<CommunityExecutionTrial> {
    this.assertAdmin(actor)
    if (typeof owner !== 'string' || !owner || owner.length > 256) throw new BusinessRuleError('invalid', 'Choose an execution owner.', 'execution-config-invalid')
    const [command, ...argv] = executionCommandLine(line), space = await this.spaces.prepare(actor.username)
    let stdout = '', stderr = '', size = 0, truncated = false
    const decoder = { stdout: new TextDecoder(), stderr: new TextDecoder() }
    let exitCode: number
    try {
      exitCode = await this.execution.execute({ username: actor.username, owner, command: command!, argv, stdin: new Uint8Array(), cwd: this.containerMembers ? '/dsh-phalanx/workspace' : space.workspace }, async event => {
        const remaining = Math.max(0, 256 * 1024 - size), data = event.data.subarray(0, remaining)
        size += data.length; truncated ||= data.length < event.data.length
        const text = decoder[event.stream].decode(data, { stream: true })
        if (event.stream === 'stdout') stdout += text; else stderr += text
      }, signal)
    } catch (error) { stderr += (error instanceof ExecutionFailure ? error : new ExecutionFailure('internal')).message + '\n'; exitCode = EXECUTION_UNAVAILABLE_EXIT }
    stdout += decoder.stdout.decode(); stderr += decoder.stderr.decode()
    return { stdout, stderr, exitCode, truncated }
  }
  private assertAdmin(actor: CommunityAccountActor): void {
    const current = this.accounts.get(actor.username)
    if (!current || current.disabled || current.spaceId !== actor.spaceId || current.sessionEpoch !== actor.sessionEpoch) throw new CommunityAuthenticationError('Sign in is required', 'sign-in-required')
    if (!current.admin) throw new BusinessRuleError('forbidden', 'Administrator access is required', 'admin-required')
  }
}
