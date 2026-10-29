import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { PlatformDatabase } from '../../src/adapters/platform-database.js'
import { PostgresPluginGrants } from '../../src/adapters/postgres-plugin-grants.js'
import { PostgresPluginInstallations } from '../../src/adapters/postgres-plugin-installations.js'
import { PostgresPluginLibraryStore } from '../../src/adapters/postgres-plugin-library.js'
import { PostgresPluginSelections } from '../../src/adapters/postgres-plugin-selections.js'
import { openTestDatabase } from './community-application.js'

/** Explicit parents for protected-store tests; production never manufactures missing plugins. */
export async function seedPluginParents(database: PlatformDatabase, names: readonly string[] = ['plugin', '@sample/plugin']): Promise<void> {
  const store = new PostgresPluginLibraryStore(database)
  for (const packageName of names) {
    if (!(await store.list()).some(row => row.packageName === packageName))
      await store.save({ packageName, version: '1.0.0', stage: 'failed', current: null, published: false })
  }
}

/** Scoped real facts for application and installed-artifact fixtures. */
export async function withPluginFacts<T>(
  root: string,
  run: (facts: {
    library: PostgresPluginLibraryStore
    grants: PostgresPluginGrants
    selections: PostgresPluginSelections
    local: PostgresPluginSelections
    installations: PostgresPluginInstallations
  }) => Promise<T>,
  installedRoot: string | undefined = process.env.DSH_PHALANX_INSTALL_ROOT,
): Promise<T> {
  const database = await openTestDatabase(root, installedRoot)
  try {
    const classes = installedRoot
      ? await Promise.all(
          ['postgres-plugin-library', 'postgres-plugin-grants', 'postgres-plugin-selections', 'postgres-plugin-installations'].map(
            name => import(pathToFileURL(join(installedRoot, 'dist/adapters', name + '.js')).href),
          ),
        )
      : undefined
    const Library: typeof PostgresPluginLibraryStore = classes?.[0]?.PostgresPluginLibraryStore ?? PostgresPluginLibraryStore
    const Grants: typeof PostgresPluginGrants = classes?.[1]?.PostgresPluginGrants ?? PostgresPluginGrants
    const Selections: typeof PostgresPluginSelections = classes?.[2]?.PostgresPluginSelections ?? PostgresPluginSelections
    const Installations: typeof PostgresPluginInstallations = classes?.[3]?.PostgresPluginInstallations ?? PostgresPluginInstallations
    return await run({
      library: new Library(database),
      grants: new Grants(database),
      selections: new Selections(database),
      local: new Selections(database, 'local'),
      installations: new Installations(database),
    })
  } finally {
    await database.close()
  }
}

import { PostgresCommunityAccountStore } from '../../src/adapters/postgres-community-accounts.js'
export async function pluginChoices(root: string): Promise<Readonly<Record<string, readonly string[]>>> {
  const database = await openTestDatabase(root, process.env.DSH_PHALANX_INSTALL_ROOT)
  try {
    const choices = new PostgresPluginSelections(database),
      accounts = new PostgresCommunityAccountStore(database)
    return Object.fromEntries(await Promise.all((await accounts.list()).map(async account => [account.spaceId, await choices.get(account.spaceId)])))
  } finally {
    await database.close()
  }
}
export async function pluginDeliveries(root: string) {
  const database = await openTestDatabase(root, process.env.DSH_PHALANX_INSTALL_ROOT)
  try {
    const history = new PostgresPluginInstallations(database),
      accounts = new PostgresCommunityAccountStore(database)
    return Object.fromEntries(await Promise.all((await accounts.list()).map(async account => [account.spaceId, await history.get(account.spaceId)])))
  } finally {
    await database.close()
  }
}
