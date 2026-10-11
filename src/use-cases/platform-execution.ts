import { EXECUTION_CREDENTIAL_NOTICE, ExecutionFailure, type ExecutionEvent, type ExecutionRequest } from '../domain/platform-execution.js'
import type { ExecutionConfigurationPort, ExecutionOwnersPort, ExecutionRunnerPort } from '../ports/platform-execution.js'

/** Recheck current owner eligibility for every call, independent of its caller (agent or terminal). */
export class PlatformExecution {
  constructor(private readonly owners: ExecutionOwnersPort, private readonly configurations: ExecutionConfigurationPort,
    private readonly runner: ExecutionRunnerPort) {}
  async execute(request: ExecutionRequest, emit: (event: ExecutionEvent) => Promise<void>, signal: AbortSignal): Promise<number> {
    const owner = this.owners.get(request.owner)
    if (!owner || !this.owners.owns(request.username, request.owner)) throw new ExecutionFailure('unauthorized')
    const configuration = this.configurations.get(owner.id)
    if (!configuration?.enabled) throw new ExecutionFailure('disabled')
    const command = configuration.commands.find(row => row.command === request.command)
    if (!command) throw new ExecutionFailure('command-missing')
    if (request.argv[0] !== undefined && command.blocked.includes(request.argv[0])) {
      await emit({ stream: 'stdout', data: new TextEncoder().encode(EXECUTION_CREDENTIAL_NOTICE) }); return 0
    }
    signal.throwIfAborted()
    return this.runner.run({ ...request, version: owner.version, environment: Object.fromEntries(configuration.variables.map(row => [row.name, row.value])) }, emit, signal)
  }
}
