import { existsSync } from 'node:fs'
import { readdir, readlink, rm } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { McpService } from '../domain/mcp-service.js'
import type { CommunityRuntimeConfig } from '../domain/community-config.js'
import { memberMcpDependenciesMount } from '../dsh/member-mcp.js'
import { FileExecutionPreparations } from './execution-preparation-store.js'
import { FileExecutionArtifacts } from './execution-artifacts.js'

/** Reads old immutable artifacts only until credential-free migration succeeds; never prepares new trees. */
export class McpMigrationArtifacts {
  private readonly member: FileExecutionPreparations
  private readonly shared: FileExecutionPreparations
  constructor(private readonly runtime: CommunityRuntimeConfig, private readonly memberInUse: () => boolean,
    private readonly sharedReaders: () => readonly string[], private readonly canDiscard: () => boolean) {
    this.member = new FileExecutionPreparations(join(runtime.dataRoot, 'mcp', 'preparations.json'))
    this.shared = new FileExecutionPreparations(join(runtime.dataRoot, 'mcp', 'shared-preparations.json'))
  }
  ready(service: McpService) {
    if (!service.run || !service.dependencyName) return undefined
    const member = service.run.location === 'member'
    const artifact = (member ? this.member : this.shared).get(`mcp:${service.preparationName ?? service.name}`)?.artifact
    if (!artifact) return undefined
    const host = join(this.runtime.dataRoot, 'mcp', member ? 'dependencies' : 'shared-dependencies', artifact.id)
    if (!existsSync(host)) return undefined
    return { directory: member && this.runtime.container ? join(memberMcpDependenciesMount, artifact.id) : host, legacy: true }
  }
  async collect(fallbacks: readonly McpService[]): Promise<void> {
    if (!this.canDiscard()) return
    const owners = (location: 'member' | 'shared') => fallbacks.filter(row => row.run?.location === location).map(row => `mcp:${row.preparationName ?? row.name}`)
    this.member.retain(owners('member')); this.shared.retain(owners('shared'))
    const shared = new FileExecutionArtifacts(join(this.runtime.dataRoot, 'mcp', 'shared-dependencies'))
    await shared.collect([...this.shared.list().flatMap(row => row.artifact ? [row.artifact.id] : []), ...this.sharedReaders()])
    if (this.memberInUse()) return
    const root = join(this.runtime.dataRoot, 'mcp', 'dependencies'), retained = this.member.list().flatMap(row => row.artifact ? [row.artifact.id] : []), trees: string[] = []
    let names: string[]
    try { names = await readdir(root) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error }
    for (const name of names) if (/^[a-f0-9]{64}$/u.test(name)) {
      if (retained.includes(name)) trees.push(basename(await readlink(join(root, name))))
      else await rm(join(root, name), { force: true })
    }
    await new FileExecutionArtifacts(join(root, '.trees')).collect(trees)
  }
}
