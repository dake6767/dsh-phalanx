import type { CommunityRuntimePort } from '../ports/community-runtime.js'
import type { RuntimeDependencyVersion } from '../domain/runtime-dependency.js'
import type { CommunityAccountStorePort } from '../ports/community-accounts.js'
import type { RuntimeDependencies } from './runtime-dependencies.js'
import type { MemberEffectiveSkills } from './member-effective-skills.js'

/** Skill ownership, including personal overrides, determines member command availability. */
export class MemberRuntimeDependencies {
  constructor(
    private readonly accounts: Pick<CommunityAccountStorePort, 'list'>,
    private readonly effective: MemberEffectiveSkills,
    private readonly dependencies: Pick<RuntimeDependencies, 'ready'>,
    private readonly runtime?: Pick<CommunityRuntimePort, 'status'>,
    private readonly reconciled: () => boolean = () => false,
    private readonly mcp: (username: string) => Promise<readonly RuntimeDependencyVersion[]> = async () => [],
    private readonly plugins: (username: string, installed: readonly string[]) => Promise<readonly string[]> = async () => [],
  ) {}
  async inUse(spaceId: string): Promise<boolean> {
    if (!this.reconciled()) return true
    const account = (await this.accounts.list()).find(row => row.spaceId === spaceId)
    return !!account && this.runtime?.status(account.username).state !== 'stopped'
  }
  async maySynchronize(spaceId: string): Promise<boolean> {
    const account = (await this.accounts.list()).find(row => row.spaceId === spaceId)
    return !account || this.runtime?.status(account.username).state !== 'starting'
  }
  async versions(spaceId: string): Promise<readonly RuntimeDependencyVersion[]> {
    const account = (await this.accounts.list()).find(row => row.spaceId === spaceId)
    const status = account ? this.runtime?.status(account.username) : undefined
    return (await this.plan(spaceId, status && 'instance' in status ? (status.instance.nativePluginSnapshot ?? []) : [])).versions
  }
  async plan(
    spaceId: string,
    installed: readonly string[],
  ): Promise<{ readonly versions: readonly RuntimeDependencyVersion[]; readonly bindings: Readonly<Record<string, RuntimeDependencyVersion>> }> {
    const account = (await this.accounts.list()).find(row => row.spaceId === spaceId && !row.disabled)
    if (!account) return { versions: [], bindings: {} }
    const [skills, plugins, mcp] = await Promise.all([
      await this.effective.accessible(account.username),
      this.plugins(account.username, installed),
      this.mcp(account.username),
    ])
    const names = [...new Set([...skills.flatMap(skill => skill.runtimeDependencies ?? []), ...plugins])].sort()
    const ready = this.dependencies.ready(names)
    return {
      versions: [...new Map([...ready, ...mcp].map(version => [version.id, version])).values()],
      bindings: Object.fromEntries(names.map((name, index) => [name, ready[index]!])),
    }
  }
}
