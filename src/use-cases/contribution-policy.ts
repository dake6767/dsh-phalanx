import { assertPluginIdentity } from '../domain/plugin-library.js'
import type { CommunityAccountActor } from '../domain/community-account.js'
import type { MemberContribution } from '../domain/member-contribution.js'
import { assertContributionMaintainer, assertPluginContributionVersion, contributionFileChanges } from '../domain/library-contribution.js'
import type { ContributionPolicyPort, ContributionPluginFilesPort } from '../ports/contribution-policy.js'
import type { PluginLibraryStorePort } from '../ports/plugin-library.js'
import type { SkillLibraryStorePort, SkillArtifactsPort } from '../ports/skill-library.js'
/** Read-only intake policy; each library commits its own provenance with the selected version. */
export class ContributionPolicy implements ContributionPolicyPort {
  constructor(private readonly skills: Pick<SkillLibraryStorePort, 'list'>, private readonly plugins: Pick<PluginLibraryStorePort, 'list'>, private readonly artifacts: Pick<SkillArtifactsPort, 'read'>, private readonly pluginFiles?: ContributionPluginFilesPort) {}
  check(kind: 'skill' | 'plugin', actor: CommunityAccountActor, name: string, version?: string): void {
    if (kind === 'plugin' && version !== undefined) assertPluginIdentity({ packageName: name, version })
    const row = this.existing(kind, name)
    assertContributionMaintainer(row?.provenance, actor)
    if (kind === 'plugin' && version) assertPluginContributionVersion(version, this.plugins.list().find(row => row.packageName === name)?.current?.version)
  }
  async review(row: MemberContribution) {
    const existing = this.existing(row.kind ?? 'skill', row.name)
    this.check(row.kind ?? 'skill', row.contributor, row.name, row.plugin?.prepared.version)
    const last = existing?.provenance?.versions.at(-1)
    const before = last?.fileHashes ?? (row.kind === 'plugin' && existing && 'current' in existing && existing.current && this.pluginFiles ? await this.pluginFiles.files(existing.current) : row.kind !== 'plugin' && existing && 'hash' in existing ? (await this.artifacts.read(existing.hash)).fileHashes ?? {} : {})
    return { anonymous: existing?.provenance?.anonymous ?? false, maintainer: existing?.provenance?.maintainer ?? null, canAssignMaintainer: !!existing && !existing.provenance?.maintainer, ...(existing ? { changes: contributionFileChanges(before, row.fileHashes ?? Object.fromEntries(row.files.map(path => [path, row.hash])), last?.declaration, row.declaration) } : {}) }
  }
  private existing(kind: 'skill' | 'plugin', name: string) { return kind === 'plugin' ? this.plugins.list().find(row => row.packageName === name) : this.skills.list().find(row => row.name === name) }
}
