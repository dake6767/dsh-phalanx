import { executionOptionBlocked } from '../domain/execution-command-line.js'
import {
  EXECUTION_CREDENTIAL_NOTICE,
  EXECUTION_UNAVAILABLE_EXIT,
  EXECUTION_USAGE_NOTICE,
  ExecutionFailure,
  executionPreparationApproved,
  type ExecutionEvent,
  type ExecutionRequest,
} from '../domain/platform-execution.js'
import { secretOutputRedactor } from '../domain/secret-output.js'
import type { UsageMember, UsageResult } from '../domain/usage-record.js'
import type { ExecutionInspectionPort } from '../ports/execution-inspection.js'
import type {
  ExecutionConfigurationPort,
  ExecutionMaterial,
  ExecutionMaterialPort,
  ExecutionOwnersPort,
  ExecutionRunnerPort,
} from '../ports/platform-execution.js'
import type { ExecutionControl } from './execution-control.js'
import type { UsagePolicy } from './usage-policy.js'

/** Recheck current owner eligibility for every call, independent of its caller (agent or terminal). */
export class PlatformExecution {
  constructor(
    private readonly owners: ExecutionOwnersPort,
    private readonly configurations: ExecutionConfigurationPort,
    private readonly runner: ExecutionRunnerPort,
    private readonly preparation?: ExecutionMaterialPort,
    private readonly inspection?: ExecutionInspectionPort,
    private readonly control?: ExecutionControl,
    private readonly usage?: Pick<UsagePolicy, 'begin'>,
  ) {}
  async execute(request: ExecutionRequest, emit: (event: ExecutionEvent) => Promise<void>, signal: AbortSignal, member?: UsageMember): Promise<number> {
    const attempt = this.usage?.begin(member ?? { username: request.username, groupId: null }, {
      kind: 'execution',
      id: request.owner,
      operation: request.command,
      ...(request.argv[0] === undefined ? {} : { firstArgument: request.argv[0] }),
    })
    let exitCode: number | undefined, reason: UsageResult['reason']
    try {
      if (attempt && !attempt.allowed) {
        reason = 'policy'
        exitCode = EXECUTION_UNAVAILABLE_EXIT
        await emit({ stream: 'stdout', data: new TextEncoder().encode(EXECUTION_USAGE_NOTICE) })
        return exitCode
      }
      const run = async (active: AbortSignal) => {
        const result = await this.perform(request, emit, active)
        reason = result.reason
        return result.exitCode
      }
      exitCode = await (this.control ? this.control.run(request, signal, run) : run(signal))
      return exitCode
    } catch (error) {
      reason = signal.aborted
        ? signal.reason instanceof ExecutionFailure
          ? signal.reason.code
          : 'cancelled'
        : error instanceof ExecutionFailure
          ? error.code
          : 'internal'
      throw error
    } finally {
      const denied = reason !== undefined && ['policy', 'blocked', 'unauthorized', 'disabled', 'not-ready', 'command-missing', 'concurrency'].includes(reason)
      try {
        await attempt?.finish({
          outcome: denied ? 'denied' : reason || exitCode !== 0 ? 'failed' : 'succeeded',
          ...(exitCode === undefined ? {} : { exitCode }),
          ...(reason === undefined ? {} : { reason }),
        })
      } catch {
        console.warn('Usage record could not be saved')
      }
    }
  }
  async recordRefusal(member: UsageMember, request: Pick<ExecutionRequest, 'owner' | 'command' | 'argv'>): Promise<void> {
    const attempt = this.usage?.begin(member, {
      kind: 'execution',
      id: request.owner,
      operation: request.command,
      ...(request.argv[0] === undefined ? {} : { firstArgument: request.argv[0] }),
    })
    try {
      await attempt?.finish({ outcome: 'denied', reason: 'unauthorized', exitCode: EXECUTION_UNAVAILABLE_EXIT })
    } catch {
      console.warn('Usage record could not be saved')
    }
  }
  private async perform(
    request: ExecutionRequest,
    emit: (event: ExecutionEvent) => Promise<void>,
    signal: AbortSignal,
  ): Promise<{ exitCode: number; reason?: 'blocked' }> {
    const owner = this.owners.get(request.owner)
    if (!owner || !(await this.owners.owns(request.username, request.owner))) throw new ExecutionFailure('unauthorized')
    const configuration = await this.configurations.get(owner.id)
    if (!configuration?.enabled) throw new ExecutionFailure('disabled')
    if (!executionPreparationApproved(owner, configuration)) throw new ExecutionFailure('not-ready')
    const command = configuration.commands.find(row => row.command === request.command)
    if (!command || (this.inspection && !(await this.inspection.available(owner.version, command.source ?? command.command))))
      throw new ExecutionFailure('command-missing')
    if ((request.argv[0] !== undefined && command.blocked.includes(request.argv[0])) || executionOptionBlocked(request.argv, command.blockedOptions ?? [])) {
      await emit({ stream: 'stdout', data: new TextEncoder().encode(EXECUTION_CREDENTIAL_NOTICE) })
      return { exitCode: 0, reason: 'blocked' }
    }
    signal.throwIfAborted()
    const secrets = configuration.variables.filter(row => row.secret).map(row => row.value)
    const output = { stdout: secretOutputRedactor(secrets), stderr: secretOutputRedactor(secrets) }
    const protectedEmit = async (event: ExecutionEvent) => {
      const data = output[event.stream].write(event.data)
      if (data.length) await emit({ stream: event.stream, data })
    }
    const run = (artifact?: ExecutionMaterial) =>
      this.runner.run(
        {
          ...request,
          command: command.source ?? request.command,
          version: artifact?.version ?? owner.version,
          ...(artifact?.dependencies ? { dependencies: artifact.dependencies } : {}),
          environment: Object.fromEntries(configuration.variables.map(row => [row.name, row.value])),
        },
        protectedEmit,
        signal,
      )
    const exitCode = await (this.preparation ? this.preparation.withPrepared(owner.id, run) : run())
    for (const stream of ['stdout', 'stderr'] as const) {
      const data = output[stream].flush()
      if (data.length) await flushOutput(() => emit({ stream, data }), signal)
    }
    return { exitCode }
  }
}

async function flushOutput(write: () => Promise<void>, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  let cancel!: () => void
  const aborted = new Promise<never>((_, reject) => {
    cancel = () => reject(signal.reason)
    signal.addEventListener('abort', cancel, { once: true })
  })
  try {
    await Promise.race([write(), aborted])
  } finally {
    signal.removeEventListener('abort', cancel)
  }
}
