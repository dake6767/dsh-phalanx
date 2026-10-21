import type { HostPreparationCache } from './host-preparation-cache.js'
import { runtimeDependencyMount } from './runtime-dependency-preparer.js'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import type { CommunityRuntimeConfig } from '../domain/community-config.js'
import { memberSkillsConfiguration, memberSkillsContainerModule, memberSkillsMount, memberSkillsPackage } from '../dsh/member-skills.js'

/** Resolve a public package entry against the selected CLI, never DSH source modules. */
export async function prepareMemberSkills(config: CommunityRuntimeConfig, spaceId: string, cache?: HostPreparationCache): Promise<{ patch: string, volumes: { host: string, mounted: string }[] }> {
  if (cache) return await cache.prepare(`skills:${spaceId}`, [config.container !== undefined, config.command, config.args], [], [join(config.dataRoot, 'skills/members', spaceId, 'entries.json'), join(config.dataRoot, 'skills/members', spaceId, 'overlay.json'), { path: join(config.dataRoot, 'runtime-dependencies/.trees'), shallow: true }], () => prepareMemberSkills(config, spaceId), () => true)
  if (!/^[a-zA-Z0-9_-]+$/u.test(spaceId)) throw new Error('Invalid member skill identity')
  const directory = join(config.dataRoot, 'skills', 'members', spaceId), mounted = config.container ? memberSkillsMount : directory
  let module = config.container ? memberSkillsContainerModule : memberSkillsPackage
  const command = config.args[0] ?? config.command
  if (!config.container && existsSync(command)) {
    try { module = createRequire(resolve(command)).resolve(memberSkillsPackage) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'MODULE_NOT_FOUND') throw error }
  }
  const contents = memberSkillsConfiguration(mounted, module)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  for (const [name, value] of [['entries.json', contents.entries], ['overlay.json', contents.overlay]] as const) {
    const path = join(directory, name), data = JSON.stringify(value)
    try { if (await readFile(path, 'utf8') === data) continue }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    const temporary = `${path}.${randomUUID()}`
    try { await writeFile(temporary, data, { mode: 0o600, flag: 'wx' }); await rename(temporary, path) }
    finally { await rm(temporary, { force: true }) }
  }
  const dependencies = join(config.dataRoot, 'runtime-dependencies', '.trees')
  await mkdir(dependencies, { recursive: true, mode: 0o700 })
  return { patch: join(mounted, 'overlay.json'), volumes: [{ host: directory, mounted }, ...(config.container ? [{ host: dependencies, mounted: runtimeDependencyMount }] : [])] }
}
