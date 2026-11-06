import type { CommunityPluginUpdateCheck, CommunityPluginView } from '../domain/admin-contract.js'
import { BusinessRuleError } from '../domain/business-error.js'
import type { CommunityAccountActor } from '../domain/community-account.js'
import { assertPluginSource, githubPluginSource, npmPluginSource, PluginPreparationError, type LibraryPlugin } from '../domain/plugin-library.js'
import type { GithubPluginArchivePort, NpmPluginSourcePort } from '../ports/plugin-source.js'
import type { PluginLibrary } from './plugin-library.js'

/** On-demand update checks for library entries; nothing is polled or applied without an administrator. */
export class PluginUpdates {
  constructor(
    private readonly library: Pick<PluginLibrary, 'updateBase' | 'replace'>,
    private readonly source: NpmPluginSourcePort,
    private readonly github: Pick<GithubPluginArchivePort, 'resolve' | 'pack' | 'discard'>,
  ) {}
  async check(actor: CommunityAccountActor, packageName: string): Promise<CommunityPluginUpdateCheck> {
    const row = await this.library.updateBase(actor, packageName)
    if (row.source.kind === 'github') return await this.checkGithub(row, row.source.repository)
    assertPluginSource(row, npmPluginSource)
    const latest = await this.source.resolve({ packageName: row.packageName, version: 'latest' }, AbortSignal.timeout(20_000))
    return {
      packageName: row.packageName,
      currentVersion: row.current?.version ?? row.version,
      latestVersion: latest.version,
      hasUpdate: latest.version !== (row.current?.version ?? row.version),
    }
  }
  /** npm compares the registry latest; GitHub compares the default-branch head with the recorded commit. */
  private async checkGithub(row: LibraryPlugin, repository: string): Promise<CommunityPluginUpdateCheck> {
    const current = this.githubCurrentCommit(row)
    const head = await this.github.resolve(repository, AbortSignal.timeout(20_000))
    return {
      packageName: row.packageName,
      currentVersion: row.current?.version ?? row.version,
      latestVersion: null,
      hasUpdate: head.commit !== current,
      currentCommit: current,
      latestCommit: head.commit,
    }
  }
  /** Resolve the next exact identity from the recorded source once, then hand it to the existing replacement precheck. */
  async prepare(actor: CommunityAccountActor, packageName: string): Promise<CommunityPluginView> {
    const row = await this.library.updateBase(actor, packageName)
    if (row.source.kind === 'github') return await this.prepareGithub(actor, row, row.source.repository)
    assertPluginSource(row, npmPluginSource)
    const latest = await this.source.resolve({ packageName: row.packageName, version: 'latest' }, AbortSignal.timeout(20_000))
    const current = row.current?.version ?? row.version
    if (latest.version === current) throw new BusinessRuleError('conflict', 'This plugin already uses the latest version.', 'plugin-up-to-date')
    return this.library.replace(actor, latest)
  }
  /** Packs the default-branch head through the same isolated flow as adding, then adopts it as the replacement candidate. */
  private async prepareGithub(actor: CommunityAccountActor, row: LibraryPlugin, repository: string): Promise<CommunityPluginView> {
    const current = this.githubCurrentCommit(row)
    const head = await this.github.resolve(repository, AbortSignal.timeout(20_000))
    if (head.commit === current) throw new BusinessRuleError('conflict', 'This plugin is already pinned to the latest commit.', 'plugin-up-to-date')
    const packed = await this.github.pack(head, AbortSignal.timeout(240_000))
    if (packed.packageName !== row.packageName) {
      // The upstream repository moved to another package name; the library entry keeps its own identity.
      await this.github.discard(packed.archive)
      throw new PluginPreparationError('plugin-package-invalid')
    }
    try {
      return await this.library.replace(
        actor,
        { packageName: packed.packageName, version: packed.version, upload: { archive: packed.archive, integrity: packed.integrity } },
        githubPluginSource(repository),
        head.commit,
      )
    } catch (error) {
      await this.github.discard(packed.archive)
      throw error
    }
  }
  private githubCurrentCommit(row: LibraryPlugin): string {
    const commit = row.current?.sourceCommit
    if (!commit) throw new PluginPreparationError('plugin-package-invalid')
    return commit
  }
}
