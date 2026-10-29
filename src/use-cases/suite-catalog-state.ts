import { compareSuiteVersions } from '../domain/suite-install.js'
import type { SuiteUnavailableReason } from './suite-availability.js'
import type { CommunitySuiteInstallView, CommunitySuiteCatalogView } from '../domain/admin-contract.js'
import type { SuiteCatalogEntry, SuiteCatalogPluginItem, SuiteCatalogExecutionItem } from '../domain/suite-catalog.js'
import { suiteExecutionOwner, type SuiteInstallState, type SuiteInstallRecord } from '../domain/suite-install.js'
import type { ExecutionSuitePort } from './suite-entry-kinds.js'

/** Catalog projections load execution facts on demand; mutation queues and recovery remain with the catalog. */
export async function suiteInstallView(
  row: SuiteInstallRecord,
  entries: readonly SuiteCatalogEntry[],
  executionPort?: Pick<ExecutionSuitePort, 'suiteExecutionStatus'>,
): Promise<CommunitySuiteInstallView> {
  const executions =
    row.status === 'installed'
      ? await Promise.all(
          row.entries.flatMap(entry =>
            entry.kind === 'execution' && executionPort ? [executionPort.suiteExecutionStatus(suiteExecutionOwner(entry.name))] : [],
          ),
        )
      : []
  const missing = [...new Set(executions.flatMap(row => row.missingCredentials))]
  const execution = executions.length
    ? { enabled: executions.every(row => row.enabled), configuredVariables: [...new Set(executions.flatMap(row => row.configuredVariables))] }
    : undefined
  // Keep actions pending until the configuration checkpoint allows them.
  return {
    id: row.id,
    category:
      row.category ??
      entries.find(entry => entry.id === row.id)?.category ??
      (row.entries.length && row.entries.every(entry => entry.kind === 'runtime-dependency') ? 'dependency' : 'suite'),
    version: row.version,
    ...(row.contentHash ? { contentHash: row.contentHash } : {}),
    status: row.status,
    entries: row.entries,
    updatedAt: row.updatedAt,
    log: row.log,
    ...(row.failureCode ? { failureCode: row.failureCode } : {}),
    ...(missing.length ? { missingCredentials: missing } : {}),
    ...(execution ? { execution } : {}),
    ...(row.dependencies?.length ? { dependencies: row.dependencies } : {}),
    ...(row.manualDependencies?.length ? { manualDependencies: row.manualDependencies } : {}),
    ...(row.replaced?.length ? { replaced: row.replaced } : {}),
  }
}

export function busySuiteDependents(installs: readonly SuiteInstallRecord[], id: string): readonly string[] {
  return installs.filter(row => row.id !== id && row.dependencies?.includes(id) && row.status !== 'installed' && row.status !== 'failed').map(row => row.id)
}

export async function suiteCatalogView(
  entries: readonly SuiteCatalogEntry[],
  state: SuiteInstallState,
  source: CommunitySuiteCatalogView['source'],
  executionPort: Pick<ExecutionSuitePort, 'suiteExecutionStatus'> | undefined,
  unavailableReason: (entry: SuiteCatalogEntry) => Promise<SuiteUnavailableReason>,
): Promise<CommunitySuiteCatalogView> {
  const executionItems = (entry: SuiteCatalogEntry) => entry.items.filter((item): item is SuiteCatalogExecutionItem => item.kind === 'execution')
  return {
    entries: await Promise.all(
      entries.map(async entry => {
        const reason = await unavailableReason(entry)
        const record = state.installs.find(row => row.id === entry.id)
        const suite = entry.category !== 'dependency' ? entry : undefined
        const packName = suite?.items.find(item => item.kind === 'skill-pack')?.name
        const plugin = suite?.items.find((item): item is SuiteCatalogPluginItem => item.kind === 'plugin')
        return {
          id: entry.id,
          category: entry.category,
          title: entry.title,
          description: entry.description,
          source: entry.source,
          version: entry.version,
          commands: [...new Set(entry.items.flatMap(item => (item.kind === 'runtime-dependency' ? item.commands : [])))],
          available: Object.keys(reason).length === 0,
          ...reason,
          ...(entry.unavailableDetail ? { unavailableDetail: entry.unavailableDetail } : {}),
          ...(suite ? { identity: suite.identity, skills: suite.items.flatMap(item => (item.kind === 'skill' ? item.names : [])) } : {}),
          ...(packName !== undefined ? { packName } : {}),
          ...(plugin ? { plugin: { packageName: plugin.packageName, version: plugin.version, integrity: plugin.integrity } } : {}),
          ...(suite?.dependencies.length ? { dependencies: suite.dependencies } : {}),
          ...(suite?.serviceAddresses?.length ? { serviceAddresses: suite.serviceAddresses } : {}),
          ...(executionItems(entry).length
            ? {
                execution: {
                  commands: executionItems(entry).flatMap(item => item.delegated),
                  variables: executionItems(entry).flatMap(item => item.variables),
                },
              }
            : {}),
          ...(record
            ? {
                installedVersion: record.version,
                ...(record.status === 'installed' && compareSuiteVersions(entry.version, record.version) > 0 ? { updateAvailable: true } : {}),
              }
            : {}),
        }
      }),
    ),
    installations: await Promise.all(state.installs.map(row => suiteInstallView(row, entries, executionPort))),
    source: source,
  }
}
