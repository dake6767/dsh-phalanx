// Frozen legacy preparation fixture for upgrade and cleanup regression only.
import { mkdir, readdir, readlink, symlink, writeFile, rename, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { basename, join } from 'node:path'
import type { CommunityRuntimeConfig } from '../../../src/domain/community-config.js'
import type { ExecutionConfiguration, ExecutionOwner } from '../../../src/domain/platform-execution.js'
import type { McpMemberPreparerPort } from '../../../src/ports/mcp-services.js'
import { memberMcpDependenciesMount } from '../../../src/dsh/member-mcp.js'
import { memberMcpFilter } from '../../../src/dsh/mcp-stdio-filter.js'
import { FileExecutionArtifacts } from '../../../src/adapters/execution-artifacts.js'
import { ContainerExecutionPreparer } from '../../../src/adapters/execution-preparer.js'
import type { ContainerExecutionProcess } from '../../../src/adapters/execution-container-process.js'

/** Only credential-free MCP dependencies live here. Stable tree paths preserve prepared interpreter entry points. */
export class MemberMcpPreparer implements McpMemberPreparerPort {
  private readonly root: string
  private readonly mounted: string
  private readonly seed: string
  private readonly artifacts: FileExecutionArtifacts
  private readonly preparer: ContainerExecutionPreparer
  constructor(config: CommunityRuntimeConfig, process: Pick<ContainerExecutionProcess, 'run' | 'recover' | 'imageIdentity' | 'canDiscardArtifacts'>) {
    this.root = join(config.dataRoot, 'mcp', 'dependencies')
    this.mounted = config.container ? memberMcpDependenciesMount : this.root
    this.seed = join(config.dataRoot, 'mcp', 'empty-seed')
    this.artifacts = new FileExecutionArtifacts(join(this.root, '.trees'))
    this.preparer = new ContainerExecutionPreparer(config, process, { directory: () => this.seed }, this.artifacts,
      directory => join(this.mounted, '.trees', basename(directory)))
  }
  directory(id: string): string {
    if (!/^[a-f0-9]{64}$/u.test(id)) throw Error('Invalid MCP dependency identity')
    return join(this.mounted, id)
  }
  identity(owner: ExecutionOwner, config: ExecutionConfiguration): string { return this.preparer.identity(owner, config) }
  async recover(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 }); await mkdir(this.seed, { recursive: true, mode: 0o700 })
    const temporary = join(this.root, 'filter-' + randomUUID() + '.mjs')
    try { await writeFile(temporary, memberMcpFilter, { mode: 0o444, flag: 'wx' }); await rename(temporary, join(this.root, 'filter.mjs')) }
    finally { await rm(temporary, { force: true }) }
    await this.preparer.recover()
  }
  async prepare(owner: ExecutionOwner, config: ExecutionConfiguration, signal: AbortSignal) {
    if (config.variables.some(row => row.secret)) throw Error('Member dependencies cannot contain platform credentials')
    const artifact = await this.preparer.prepare(owner, config, signal)
    try { await symlink(join('.trees', artifact.id), join(this.root, artifact.hash)) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
    return { ...artifact, id: artifact.hash }
  }
  async collect(): Promise<void> {
    // Published trees may still be held by a hot-reloading member process. Never unlink those live paths.
    // Unpublished/interrupted stages are safe once the shared preparation owner has drained its jobs.
    const trees: string[] = []
    for (const name of await readdir(this.root)) if (/^[a-f0-9]{64}$/u.test(name)) {
      const target = await readlink(join(this.root, name))
      if (!/^\.trees\/[a-f0-9]{64}$/u.test(target)) throw Error('Invalid MCP dependency link')
      trees.push(basename(target))
    }
    await this.preparer.collect(trees)
  }
}
