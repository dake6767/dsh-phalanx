import { BusinessRuleError } from '../domain/business-error.js'
import { CommunityAuthenticationError, type CommunityAccountActor } from '../domain/community-account.js'
import type { CommunityAccountReaderPort } from '../ports/community-accounts.js'
import type { PluginLibraryStorePort } from '../ports/plugin-library.js'
import type { PluginDownloadTokensPort } from '../ports/native-plugin-downloads.js'
import type { Clock } from '../ports/clock.js'

/** Member-bound access to retained checked bytes; callers decide market or preinstall eligibility. */
export class NativePluginDownloads {
  constructor(private readonly accounts: Pick<CommunityAccountReaderPort, 'get'>, private readonly library: Pick<PluginLibraryStorePort, 'list'>,
    private readonly tokens: PluginDownloadTokensPort, private readonly clock: Clock, private readonly runtimeRevision: string) {}
  issue(actor: CommunityAccountActor, packageName: string) {
    const account = this.accounts.get(actor.username)
    if (!account || account.disabled || account.spaceId !== actor.spaceId || account.sessionEpoch !== actor.sessionEpoch) throw new CommunityAuthenticationError('Sign in is required', 'sign-in-required')
    const plugin = this.available(packageName)
    const token = this.tokens.issue({ username: account.username, spaceId: account.spaceId, sessionEpoch: account.sessionEpoch,
      packageName, artifact: plugin.artifact, integrity: plugin.integrity, expiresAt: this.clock.now() + 60_000 })
    return { plugin, url: `http://plugins.dsh-phalanx.invalid/plugin-archive/${token}.tgz` }
  }
  read(token: string, username: string) {
    const grant = this.tokens.read(token), account = this.accounts.get(username)
    if (!grant || grant.username !== username || grant.expiresAt <= this.clock.now() || !account || account.disabled
      || account.spaceId !== grant.spaceId || account.sessionEpoch !== grant.sessionEpoch) throw this.denied()
    const plugin = this.available(grant.packageName)
    if (plugin.integrity !== grant.integrity || plugin.artifact !== grant.artifact) throw this.denied()
    return plugin
  }
  private available(packageName: string) {
    const row = this.library.list().find(row => row.packageName === packageName)
    if (!row || row.removing || row.incompatible || row.stage !== 'available' || row.current?.runtimeRevision !== this.runtimeRevision) throw this.denied()
    return row.current
  }
  private denied() { return new BusinessRuleError('forbidden', 'This plugin download is no longer available.', 'plugin-download-denied') }
}
