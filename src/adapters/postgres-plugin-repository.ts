import { repositorySql, repositoryTransaction, type RowRepositoryConnection } from './postgres-row-repository.js'
/** Facts the synchronous plugin admission fence observes, including cascade parents. */
const authorizationTables = [
  'accounts',
  'groups',
  'plugin_library',
  'plugin_runtime_dependencies',
  'plugin_grants',
  'plugin_choices',
  'plugin_upstream_settings',
  'plugin_upstreams',
].map(table => 'dsh_phalanx.' + table)

export type PluginRepositoryConnection = RowRepositoryConnection
export const pluginSql = repositorySql
export const pluginTransaction = repositoryTransaction
export function pluginAuthorizationRevision(connection: PluginRepositoryConnection): string {
  if ('sql' in connection) throw Error('A transaction repository has no synchronous authorization view')
  return connection.writeRevision(authorizationTables)
}
