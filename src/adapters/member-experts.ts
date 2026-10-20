import { randomUUID } from 'node:crypto'
import { chmod, cp, lstat, mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { CommunityRuntimeConfig } from '../domain/community-config.js'
import type { ExpertFailure } from '../domain/expert.js'
import type { ExpertMemberPlan, ExpertSkillProjectionPort } from '../ports/experts.js'
import { expertBaseTools } from '../dsh/expert-base-tools.js'
import { expertPresetId, projectExpertPreset } from '../dsh/expert-preset.js'
import { FileSkillArtifacts } from './skill-artifacts.js'
import type { PreparedPlugin } from '../domain/plugin-library.js'
import { expertPluginLoader, expertPluginStatusObserver } from '../dsh/expert-plugins.js'
import type { McpService } from '../domain/mcp-service.js'
import { memberMcpEntries } from '../dsh/member-mcp.js'
import { memberMcpModule, memberMcpPreparation } from './mcp-projection.js'

/** Each startup gets immutable preset/skill bytes in a platform-owned readonly volume. */
export async function prepareMemberExperts(config: CommunityRuntimeConfig, spaceId: string, plans: readonly ExpertMemberPlan[], execution?: ExpertSkillProjectionPort,
  pluginPreparation?: { readonly plugins: readonly PreparedPlugin[], readonly global: readonly string[], readonly entries: Readonly<Record<string, readonly Record<string, unknown>[]>> },
  mcpPreparation?: { readonly services: readonly McpService[], readonly global: readonly string[] }) {
  if (!/^[a-zA-Z0-9_-]+$/u.test(spaceId)) throw new Error('Invalid expert member identity')
  const host = join(config.dataRoot, 'experts', 'members', spaceId), mounted = config.container ? '/dsh-phalanx/experts' : host
  const generation = `generation-${randomUUID()}`, directory = join(host, generation)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await writeFile(join(directory, 'plugin-loader.mjs'), expertPluginLoader, { mode: 0o600 })
  await writeFile(join(directory, 'plugin-status.mjs'), expertPluginStatusObserver, { mode: 0o600 })
  const artifacts = new FileSkillArtifacts(join(config.dataRoot, 'skills', 'artifacts'), [])
  const mcpModule = memberMcpModule(config), mcpDirectory = memberMcpPreparation(config, spaceId).volumes[0]!.mounted
  const mcpEntries = (mcpPreparation?.services ?? []).map(service => ({ name: service.name, entry: JSON.parse(memberMcpEntries([service], mcpModule, mcpDirectory))[0] as Record<string, unknown> }))
  const entries: Record<string, unknown>[] = [{ id: 'phalanx-expert-plugin-status', name: join(mounted, generation, 'plugin-status.mjs') }], failures: ExpertFailure[] = [], expected: { id: string, preset: string }[] = []
  for (const plan of plans) {
    const failed = [...plan.failures], available: string[] = []
    try {
      const skillsDirectory = join(directory, plan.expert.id, 'skills')
      await mkdir(skillsDirectory, { recursive: true, mode: 0o700 })
      for (const skill of plan.skills) {
        if (plan.globalSkills.includes(skill.name)) continue
        const staging = join(directory, `.skill-${randomUUID()}`)
        try {
          const target = join(skillsDirectory, skill.name)
          await cp(artifacts.directory(skill.hash), staging, { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true })
          await writableDirectories(staging)
          await rename(staging, target)
          available.push(skill.name)
        }
        catch { failed.push(`skill:${skill.name}`) }
        finally { try { await removePreparedTree(staging) } catch { failed.push(`skill:${skill.name}`) } }
      }
      await execution?.apply(spaceId, skillsDirectory)
      const projection = projectExpertPreset(plan.expert, { base: expertBaseTools(process.platform), requestedSkills: plan.requestedSkills,
        availableSkills: available, globalSkills: plan.globalSkills, skillsDirectory: join(mounted, generation, plan.expert.id, 'skills'),
        pluginProjection: { requested: plan.expert.plugins, global: pluginPreparation?.global ?? [], available: (pluginPreparation?.plugins ?? []).flatMap(plugin => {
          const entries = pluginPreparation?.entries[plugin.packageName]
          return entries ? [{ packageName: plugin.packageName, entries, services: plugin.services ?? [] }] : []
        }), loader: join(mounted, generation, 'plugin-loader.mjs') },
        mcpProjection: { requested: plan.expert.mcp, global: mcpPreparation?.global ?? [], available: mcpEntries } })
      failed.push(...projection.failures); entries.push(projection.preset)
      expected.push({ id: plan.expert.id, preset: expertPresetId(plan.expert.id) })
    } catch { failed.push('preset') }
    if (failed.length) failures.push({ id: plan.expert.id, entries: [...new Set(failed)].sort() })
  }
  await writeFile(join(directory, 'overlay.json'), JSON.stringify([{ insert: entries }]), { mode: 0o600, flag: 'wx' })
  // The lifecycle stops the previous instance before preparing its replacement.
  for (const name of await readdir(host)) if (name !== generation && /^generation-[a-f0-9-]+$/u.test(name)) {
    try { await removePreparedTree(join(host, name)) }
    catch { console.warn('Expert projection cleanup failed; retained an unused generation') }
  }
  return { patch: join(mounted, generation, 'overlay.json'), volumes: [{ host, mounted }], failures, expected,
    snapshot: plans.map(plan => `${plan.expert.id}:${plan.expert.revision}`).sort() }
}

/** Source artifacts have readonly directories; the readonly bind mount protects the member copy. */
async function writableDirectories(directory: string): Promise<void> {
  if (!(await lstat(directory)).isDirectory()) throw new Error('Unexpected expert skill directory')
  await chmod(directory, 0o700)
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) await writableDirectories(join(directory, entry.name))
    else if (!entry.isFile()) throw new Error('Unexpected expert skill entry')
  }
}

/** Cleanup must unlink unexpected entries without traversing them or rejecting the whole startup. */
async function removePreparedTree(path: string): Promise<void> {
  try {
    if ((await lstat(path)).isDirectory()) {
      await chmod(path, 0o700)
      for (const name of await readdir(path)) await removePreparedTree(join(path, name))
    }
    await rm(path, { recursive: true, force: true })
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
}
