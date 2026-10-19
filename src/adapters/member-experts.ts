import { randomUUID } from 'node:crypto'
import { chmod, cp, mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { CommunityRuntimeConfig } from '../domain/community-config.js'
import type { ExpertFailure } from '../domain/expert.js'
import type { ExpertMemberPlan, ExpertSkillProjectionPort } from '../ports/experts.js'
import { expertBaseTools } from '../dsh/expert-base-tools.js'
import { expertPresetId, projectExpertPreset } from '../dsh/expert-preset.js'
import { FileSkillArtifacts } from './skill-artifacts.js'

/** Each startup gets immutable preset/skill bytes in a platform-owned readonly volume. */
export async function prepareMemberExperts(config: CommunityRuntimeConfig, spaceId: string, plans: readonly ExpertMemberPlan[], execution?: ExpertSkillProjectionPort) {
  if (!/^[a-zA-Z0-9_-]+$/u.test(spaceId)) throw new Error('Invalid expert member identity')
  const host = join(config.dataRoot, 'experts', 'members', spaceId), mounted = config.container ? '/dsh-phalanx/experts' : host
  const generation = `generation-${randomUUID()}`, directory = join(host, generation)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const artifacts = new FileSkillArtifacts(join(config.dataRoot, 'skills', 'artifacts'), [])
  const entries: Record<string, unknown>[] = [], failures: ExpertFailure[] = [], expected: { id: string, preset: string }[] = []
  for (const plan of plans) {
    const failed = [...plan.failures], available: string[] = []
    try {
      const skillsDirectory = join(directory, plan.expert.id, 'skills')
      await mkdir(skillsDirectory, { recursive: true, mode: 0o700 })
      for (const skill of plan.skills) {
        if (plan.globalSkills.includes(skill.name)) continue
        try {
          const target = join(skillsDirectory, skill.name)
          await cp(artifacts.directory(skill.hash), target, { recursive: true, errorOnExist: true, force: false })
          await writableDirectories(target)
          available.push(skill.name)
        }
        catch { failed.push(`skill:${skill.name}`) }
      }
      await execution?.apply(spaceId, skillsDirectory)
      const projection = projectExpertPreset(plan.expert, { base: expertBaseTools(process.platform), requestedSkills: plan.requestedSkills,
        availableSkills: available, globalSkills: plan.globalSkills, skillsDirectory: join(mounted, generation, plan.expert.id, 'skills') })
      failed.push(...projection.failures); entries.push(projection.preset)
      expected.push({ id: plan.expert.id, preset: expertPresetId(plan.expert.id) })
    } catch { failed.push('preset') }
    if (failed.length) failures.push({ id: plan.expert.id, entries: [...new Set(failed)].sort() })
  }
  await writeFile(join(directory, 'overlay.json'), JSON.stringify([{ insert: entries }]), { mode: 0o600, flag: 'wx' })
  // The lifecycle stops the previous instance before preparing its replacement.
  for (const name of await readdir(host)) if (name !== generation && /^generation-[a-f0-9-]+$/u.test(name)) { await writableDirectories(join(host, name)); await rm(join(host, name), { recursive: true, force: true }) }
  return { patch: join(mounted, generation, 'overlay.json'), volumes: [{ host, mounted }], failures, expected,
    snapshot: plans.map(plan => `${plan.expert.id}:${plan.expert.revision}`).sort() }
}

/** Source artifacts have readonly directories; the readonly bind mount protects the member copy. */
async function writableDirectories(directory: string): Promise<void> {
  await chmod(directory, 0o700)
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) await writableDirectories(join(directory, entry.name))
    else if (!entry.isFile()) throw new Error('Unexpected expert skill entry')
  }
}
