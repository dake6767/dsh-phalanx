import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { PostgresContributionRows } from '../../src/adapters/postgres-contribution-rows.js'
import { openTestDatabase } from './community-application.js'

/** Inspect the running layout's actual PostgreSQL records, including installed candidate adapters. */
export async function contributionRecords(root: string, installedRoot = process.env.DSH_PHALANX_INSTALL_ROOT) {
  const database = await openTestDatabase(root, installedRoot)
  try {
    const Store: typeof PostgresContributionRows = installedRoot
      ? (await import(pathToFileURL(join(installedRoot, 'dist/adapters/postgres-contribution-rows.js')).href)).PostgresContributionRows
      : PostgresContributionRows
    return await new Store(database).list()
  } finally {
    await database.close()
  }
}
