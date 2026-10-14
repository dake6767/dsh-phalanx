import type { CommunityRuntimePort } from '../ports/community-runtime.js'
import type { RuntimeDependencyVersion } from '../domain/runtime-dependency.js'
import type { CommunityAccountStorePort } from '../ports/community-accounts.js'
import type { RuntimeDependencies } from './runtime-dependencies.js'
import type { MemberEffectiveSkills } from './member-effective-skills.js'

/** Skill ownership, including personal overrides, determines member command availability. */
export class MemberRuntimeDependencies {
  constructor(private readonly accounts: Pick<CommunityAccountStorePort, 'list'>,
    private readonly effective: MemberEffectiveSkills, private readonly dependencies: Pick<RuntimeDependencies, 'ready'>, private readonly runtime?: Pick<CommunityRuntimePort, 'status'>, private readonly reconciled: () => boolean = () => false, private readonly mcp: (username: string) => readonly RuntimeDependencyVersion[] = () => []) {}
  inUse(spaceId: string): boolean {
    if (!this.reconciled()) return true
    const account = this.accounts.list().find(row => row.spaceId === spaceId)
    return !!account && this.runtime?.status(account.username).state !== 'stopped'
  }
  versions(spaceId: string): readonly RuntimeDependencyVersion[] {
    const account = this.accounts.list().find(row => row.spaceId === spaceId && !row.disabled)
    if (!account) return []
    const names = [...new Set(this.effective.effective(account.username).flatMap(row => row.skill.runtimeDependencies ?? []))].sort()
    return [...new Map([...this.dependencies.ready(names), ...this.mcp(account.username)].map(version => [version.id, version])).values()]
  }
}
