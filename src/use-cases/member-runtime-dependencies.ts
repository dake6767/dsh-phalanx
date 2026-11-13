import { planNativeDependencyCommands } from './member-native-dependency-plan.js'
import type { MemberRuntimeDependenciesPort } from '../ports/member-runtime-dependencies.js'
import type { NativePluginArchiveFacts, NativePluginDependencyPlans, PluginPreinstallPlan } from '../domain/plugin-preinstall.js'
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
    private readonly nativeResources: (username: string, archives: NativePluginArchiveFacts) => Promise<NativePluginDependencyPlans> = async () => ({}),
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
    const instance = status && 'instance' in status ? status.instance : undefined
    const pending = instance?.preinstallPlan
    const launched = Object.fromEntries(Object.entries(pending?.dependencies ?? {}).filter(([name]) => !pending?.blocked?.includes(name)))
    return (await this.plan(spaceId, instance?.nativePluginSnapshot ?? [], launched, instance?.nativeArchiveSnapshot)).versions
  }
  async plan(
    spaceId: string,
    installed: readonly string[],
    preinstalls: PluginPreinstallPlan['dependencies'] = {},
    archives: NativePluginArchiveFacts = {},
  ): ReturnType<MemberRuntimeDependenciesPort['plan']> {
    const account = (await this.accounts.list()).find(row => row.spaceId === spaceId && !row.disabled)
    if (!account) return { versions: [], bindings: {} }
    const [skills, plugins, mcp, native] = await Promise.all([
      await this.effective.accessible(account.username),
      this.plugins(account.username, installed),
      this.mcp(account.username),
      this.nativeResources(account.username, archives),
    ])
    const names = [...new Set([...skills.flatMap(skill => skill.runtimeDependencies ?? []), ...plugins])].sort()
    const ready = this.dependencies.ready(names)
    const base = new Map(names.map((name, index) => [name, ready[index]!]))
    const packages = { ...preinstalls, ...native }
    const { bindings, blocked: blockedPreinstalls } = planNativeDependencyCommands(packages, base, names => this.dependencies.ready(names), mcp)
    const nativeResources = Object.fromEntries(Object.entries(packages).filter(([name]) => !blockedPreinstalls.includes(name)))
    const versions = new Map([...bindings.values()].map(version => [version.id, version]))
    for (const version of mcp) if (!versions.has(version.id)) versions.set(version.id, version)
    return {
      versions: [...versions.values()],
      bindings: Object.fromEntries(bindings),
      ...(Object.keys(nativeResources).length ? { nativeResources } : {}),
      ...(blockedPreinstalls.length ? { blockedPreinstalls } : {}),
    }
  }
}
