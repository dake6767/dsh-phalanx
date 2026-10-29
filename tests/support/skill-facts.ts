import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { PostgresSkillLibraryStore } from '../../src/adapters/postgres-skill-library.js'
import { openTestDatabase } from './community-application.js'

/** Seed current skill facts using the same database and adapter bytes as the application under test. */
export async function withSkillFacts<T>(
  root: string,
  run: (library: PostgresSkillLibraryStore) => Promise<T>,
  installedRoot = process.env.DSH_PHALANX_INSTALL_ROOT,
): Promise<T> {
  const database = await openTestDatabase(root, installedRoot)
  try {
    const Store: typeof PostgresSkillLibraryStore = installedRoot
      ? (await import(pathToFileURL(join(installedRoot, 'dist/adapters/postgres-skill-library.js')).href)).PostgresSkillLibraryStore
      : PostgresSkillLibraryStore
    return await run(new Store(database))
  } finally {
    await database.close()
  }
}
