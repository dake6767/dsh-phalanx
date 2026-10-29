import { randomUUID } from 'node:crypto'
import { BusinessRuleError } from '../domain/business-error.js'
import type { CatalogInstallRecord, CatalogRequestResult } from '../domain/catalog-install.js'
import type { CatalogInstallRows, CatalogInstallRow, CatalogRequestRows, CatalogRequestRow } from '../ports/catalog-records.js'
import { repositorySql, repositoryTransaction, type RowRepositoryConnection } from './postgres-row-repository.js'
import { catalogRequestLock } from './advisory-locks.js'

const installFields = new Set([
  'id',
  'version',
  'category',
  'dependencyNames',
  'pluginPackage',
  'contentHash',
  'status',
  'entries',
  'requestId',
  'updatedAt',
  'log',
  'failureCode',
  'dependencies',
  'manualDependencies',
  'replaced',
  'detached',
])
const installChanged = () => new BusinessRuleError('conflict', 'The catalog entry changed. Review it again.', 'suite-task-running')
const requestChanged = () =>
  new BusinessRuleError('conflict', 'This install request was already used. Read its result before retrying.', 'suite-request-retired')
function checked(record: CatalogInstallRecord): CatalogInstallRecord {
  if (
    !record ||
    typeof record !== 'object' ||
    Object.keys(record).some(key => !installFields.has(key)) ||
    typeof record.id !== 'string' ||
    !record.id ||
    typeof record.version !== 'string' ||
    !record.version ||
    !['installing', 'installed', 'failed', 'uninstalling', 'updating'].includes(record.status) ||
    !Array.isArray(record.entries) ||
    !Number.isFinite(record.updatedAt) ||
    typeof record.log !== 'string'
  )
    throw new BusinessRuleError('invalid', 'Invalid catalog record; persisted compensation snapshots are unsupported.', 'suite-catalog-invalid')
  return structuredClone(record)
}
interface InstallRow {
  entry_id: string
  record: CatalogInstallRecord
  row_revision: string
}
interface RequestRow {
  request_id: string
  result: CatalogRequestResult
  row_revision: string
}

/** Ordinary catalog reads query rows; no installation state snapshot is retained in the process. */
export class PostgresCatalogInstalls implements CatalogInstallRows {
  constructor(private readonly connection: RowRepositoryConnection) {}
  async get(id: string): Promise<CatalogInstallRow | undefined> {
    const [row] = await repositorySql(this.connection).query<InstallRow>(
      'SELECT entry_id,record,row_revision FROM dsh_phalanx.catalog_installs WHERE entry_id=$1',
      [id],
    )
    return row ? { record: checked(row.record), revision: row.row_revision } : undefined
  }
  async list(): Promise<readonly CatalogInstallRow[]> {
    return (
      await repositorySql(this.connection).query<InstallRow>('SELECT entry_id,record,row_revision FROM dsh_phalanx.catalog_installs ORDER BY entry_id')
    ).map(row => ({ record: checked(row.record), revision: row.row_revision }))
  }
  async lock(id: string, expectedRevision: string): Promise<CatalogInstallRecord> {
    if (!('sql' in this.connection)) throw Error('Catalog row locks require a transaction')
    const [row] = await this.connection.sql.query<InstallRow>(
      'SELECT entry_id,record,row_revision FROM dsh_phalanx.catalog_installs WHERE entry_id=$1 FOR UPDATE',
      [id],
    )
    if (!row || row.row_revision !== expectedRevision) throw installChanged()
    return checked(row.record)
  }
  async save(input: CatalogInstallRecord, expectedRevision = 'none'): Promise<void> {
    const record = checked(input),
      revision = randomUUID()
    const saved = await repositorySql(this.connection).query(
      expectedRevision === 'none'
        ? 'INSERT INTO dsh_phalanx.catalog_installs(entry_id,state,record,row_revision) VALUES($1,$2,$3,$4) ON CONFLICT(entry_id) DO NOTHING RETURNING entry_id'
        : 'UPDATE dsh_phalanx.catalog_installs SET state=$2,record=$3,row_revision=$4 WHERE entry_id=$1 AND row_revision=$5 RETURNING entry_id',
      expectedRevision === 'none'
        ? [record.id, record.status, JSON.stringify(record), revision]
        : [record.id, record.status, JSON.stringify(record), revision, expectedRevision],
    )
    if (!saved.length) throw installChanged()
  }
  async remove(id: string, expectedRevision: string): Promise<void> {
    const removed = await repositorySql(this.connection).query(
      'DELETE FROM dsh_phalanx.catalog_installs WHERE entry_id=$1 AND row_revision=$2 RETURNING entry_id',
      [id, expectedRevision],
    )
    if (!removed.length) throw installChanged()
  }
}

/** The last 200 request results survive install removal; uniqueness and CAS prevent duplicate claims. */
export class PostgresCatalogRequests implements CatalogRequestRows {
  constructor(private readonly connection: RowRepositoryConnection) {}
  async lockLedger(): Promise<void> {
    if (!('sql' in this.connection)) throw Error('Catalog ledger locks require a transaction')
    await this.connection.sql.query(catalogRequestLock)
  }
  async get(requestId: string): Promise<CatalogRequestRow | undefined> {
    const [row] = await repositorySql(this.connection).query<RequestRow>(
      'SELECT request_id,result,row_revision FROM dsh_phalanx.catalog_requests WHERE request_id=$1',
      [requestId],
    )
    return row ? { requestId: row.request_id, result: row.result, revision: row.row_revision } : undefined
  }
  async save(requestId: string, input: CatalogRequestResult, expectedRevision = 'none'): Promise<void> {
    const result = structuredClone(input),
      revision = randomUUID()
    if (
      !requestId ||
      !result ||
      Object.keys(result).some(key => !['id', 'version', 'status'].includes(key)) ||
      !result.id ||
      !result.version ||
      !['pending', 'complete', 'failed', 'retired'].includes(result.status)
    )
      throw new BusinessRuleError('invalid', 'Invalid catalog request result.', 'suite-catalog-invalid')
    await repositoryTransaction(this.connection, async sql => {
      await sql.query(catalogRequestLock)
      const saved = await sql.query(
        expectedRevision === 'none'
          ? `INSERT INTO dsh_phalanx.catalog_requests(request_id,result,row_revision,position)
          SELECT $1,$2,$3,COALESCE(max(position),0)+1 FROM dsh_phalanx.catalog_requests ON CONFLICT(request_id) DO NOTHING RETURNING request_id`
          : 'UPDATE dsh_phalanx.catalog_requests SET result=$2,row_revision=$3 WHERE request_id=$1 AND row_revision=$4 RETURNING request_id',
        expectedRevision === 'none' ? [requestId, JSON.stringify(result), revision] : [requestId, JSON.stringify(result), revision, expectedRevision],
      )
      if (!saved.length) throw requestChanged()
      await sql.query(`DELETE FROM dsh_phalanx.catalog_requests WHERE request_id IN (
        SELECT request_id FROM dsh_phalanx.catalog_requests ORDER BY position DESC OFFSET 200)`)
    })
  }
}
