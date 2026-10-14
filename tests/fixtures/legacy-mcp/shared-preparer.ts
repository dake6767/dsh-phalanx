// Frozen legacy preparation fixture for upgrade and cleanup regression only.
import { mkdir } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { CommunityRuntimeConfig } from '../../../src/domain/community-config.js'
import type { ExecutionConfiguration, ExecutionOwner } from '../../../src/domain/platform-execution.js'
import type { McpMemberPreparerPort } from '../../../src/ports/mcp-services.js'
import { ContainerExecutionPreparer } from '../../../src/adapters/execution-preparer.js'
import { FileExecutionArtifacts } from '../../../src/adapters/execution-artifacts.js'
import type { ContainerExecutionProcess } from '../../../src/adapters/execution-container-process.js'

export const sharedMcpMount = '/dsh-phalanx/shared-mcp'
/** Private credential-bearing trees are never placed in the member dependency root. */
export class SharedMcpPreparer implements McpMemberPreparerPort {
  private readonly artifacts: FileExecutionArtifacts
  private readonly preparer: ContainerExecutionPreparer
  private readonly seed: string
  constructor(runtime: CommunityRuntimeConfig, process: Pick<ContainerExecutionProcess, 'run' | 'recover' | 'imageIdentity' | 'canDiscardArtifacts'>, private readonly readers: () => readonly string[] = () => []) {
    this.seed = join(runtime.dataRoot, 'mcp', 'shared-seed')
    this.artifacts = new FileExecutionArtifacts(join(runtime.dataRoot, 'mcp', 'shared-dependencies'))
    this.preparer = new ContainerExecutionPreparer(runtime, process, { directory: () => this.seed }, this.artifacts,
      directory => join(sharedMcpMount, basename(directory)))
  }
  directory(id: string): string { return this.artifacts.directory(id) }
  identity(owner: ExecutionOwner, config: ExecutionConfiguration): string { return this.preparer.identity(owner, config) }
  async recover(): Promise<void> { await mkdir(this.seed, { recursive: true, mode: 0o700 }); await this.preparer.recover() }
  prepare(owner: ExecutionOwner, config: ExecutionConfiguration, signal: AbortSignal) { return this.preparer.prepare(owner, config, signal) }
  collect(retained: readonly string[]): Promise<void> { return this.preparer.collect([...retained, ...this.readers()]) }
}
