import type { CommunityRuntimePort } from '../ports/community-runtime.js'
import type { RuntimeDependencyVersion } from '../domain/runtime-dependency.js'
import type { CommunityAccountStorePort } from '../ports/community-accounts.js'
import type { RuntimeDependencies } from './runtime-dependencies.js'
import type { MemberEffectiveSkills } from './member-effective-skills.js'

/** Skill ownership, including personal overrides, determines member command availability. */
export class MemberRuntimeDependencies {
  constructor(private readonly accounts: Pick<CommunityAccountStorePort, 'list'>,
    private readonly effective: MemberEffectiveSkills, private readonly dependencies: Pick<RuntimeDependencies, 'ready'>, private readonly runtime?: Pick<CommunityRuntimePort, 'status'>, private readonly reconciled: () => boolean = () => false, private readonly mcp: (username: string) => readonly RuntimeDependencyVersion[] = () => [], private readonly plugins: (username: string, installed: readonly string[]) => readonly string[] = () => []) {}
  inUse(spaceId: string): boolean {
    if (!this.reconciled()) return true
    const account = this.accounts.list().find(row => row.spaceId === spaceId)
    return !!account && this.runtime?.status(account.username).state !== 'stopped'
  }
  maySynchronize(spaceId: string): boolean {
    const account = this.accounts.list().find(row => row.spaceId === spaceId)
    return !account || this.runtime?.status(account.username).state !== 'starting'
  }
  versions(spaceId: string): readonly RuntimeDependencyVersion[] {
    const account = this.accounts.list().find(row => row.spaceId === spaceId)
    const status = account ? this.runtime?.status(account.username) : undefined
    return this.plan(spaceId, status && 'instance' in status ? status.instance.nativePluginSnapshot ?? [] : []).versions
  }
  plan(spaceId: string, installed: readonly string[]): { readonly versions: readonly RuntimeDependencyVersion[], readonly bindings: Readonly<Record<string, RuntimeDependencyVersion>> } {
    const account = this.accounts.list().find(row => row.spaceId === spaceId && !row.disabled)
    if (!account) return { versions: [], bindings: {} }
    const names = [...new Set([...this.effective.accessible(account.username).flatMap(skill => skill.runtimeDependencies ?? []), ...this.plugins(account.username, installed)])].sort()
    const ready = this.dependencies.ready(names)
    return { versions: [...new Map([...ready, ...this.mcp(account.username)].map(version => [version.id, version])).values()], bindings: Object.fromEntries(names.map((name, index) => [name, ready[index]!])) }
  }
}
