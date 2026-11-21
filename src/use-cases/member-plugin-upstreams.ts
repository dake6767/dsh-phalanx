import type { PluginAccessStorePort } from '../ports/plugin-access.js'
import type { PluginUpstreamsPort } from '../ports/plugin-upstreams.js'

/** Native service upstreams are only reachable through their scoped gateway. */
export class MemberPluginUpstreams {
  constructor(
    private readonly upstreams: Pick<PluginUpstreamsPort, 'list'> & Required<Pick<PluginUpstreamsPort, 'authorizationRevision'>>,
    private readonly access: Required<Pick<PluginAccessStorePort, 'installedServices'>>,
  ) {}

  authorizationRevision(packageName: string): string {
    return this.upstreams.authorizationRevision(packageName)
  }

  async list(packageName: string) {
    const [upstreams, services] = await Promise.all([this.upstreams.list(packageName), this.access.installedServices(packageName)])
    const reserved = new Set(services?.configuration.slots.flatMap(({ binding }) => (binding.kind === 'json-settings' ? [binding.upstream] : [])))
    return upstreams.filter(row => !row.nativeServiceOnly && !reserved.has(row.name))
  }
}
