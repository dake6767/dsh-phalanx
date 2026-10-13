import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import type { CommunityRuntimeConfig } from '../domain/community-config.js'
import type { McpProjectionPort, McpProjectionMember } from '../ports/mcp-services.js'
import { memberMcpDependenciesMount, memberMcpContainerModule, memberMcpEntries, memberMcpMount, memberMcpOverlay, memberMcpPackage, memberMcpWatcher } from '../dsh/member-mcp.js'
import { memberSharedMcpClient } from '../dsh/mcp-shared-client.js'

/** Each readonly mount exposes only this member's effective service names and gateway configuration. */
export class FileMcpProjection implements McpProjectionPort {
  constructor(private readonly config: CommunityRuntimeConfig) {}
  async synchronize(members: readonly McpProjectionMember[]): Promise<void> {
    await mkdir(join(this.config.dataRoot, 'mcp', 'dependencies'), { recursive: true, mode: 0o700 })
    let module = this.config.container ? memberMcpContainerModule : memberMcpPackage
    const command = this.config.args[0] ?? this.config.command
    if (!this.config.container && existsSync(command)) {
      try { module = createRequire(resolve(command)).resolve(memberMcpPackage) }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'MODULE_NOT_FOUND') throw error }
    }
    for (const member of members) {
      const prepared = memberMcpPreparation(this.config, member.spaceId)
      const directory = prepared.volumes[0]!.host, mounted = prepared.volumes[0]!.mounted
      await mkdir(directory, { recursive: true, mode: 0o700 })
      for (const [name, data] of [['initial.json', '[]'], ['watch.mjs', memberMcpWatcher], ['shared-client.mjs', memberSharedMcpClient], ['overlay.json', memberMcpOverlay(mounted, module)], ['entries.json', memberMcpEntries(member.services, module, mounted)]]) {
        const path = join(directory, name!)
        try { if (await readFile(path, 'utf8') === data) continue }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
        const temporary = `${path}.${randomUUID()}`
        try { await writeFile(temporary, data!, { flag: 'wx', mode: 0o600 }); await rename(temporary, path) }
        finally { await rm(temporary, { force: true }) }
      }
    }
  }
}
export function memberMcpPreparation(config: CommunityRuntimeConfig, spaceId: string) {
  if (!/^[A-Za-z0-9_-]+$/u.test(spaceId)) throw new Error('Invalid MCP member identity')
  const host = join(config.dataRoot, 'mcp', 'members', spaceId), mounted = config.container ? memberMcpMount : host
  const dependencies = join(config.dataRoot, 'mcp', 'dependencies')
  return { patch: join(mounted, 'overlay.json'), volumes: [{ host, mounted }, { host: dependencies, mounted: config.container ? memberMcpDependenciesMount : dependencies }] }
}
