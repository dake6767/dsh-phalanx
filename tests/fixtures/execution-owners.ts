import type { PlatformDatabase } from '../../src/adapters/platform-database.js'
import { PostgresSkillLibraryStore } from '../../src/adapters/postgres-skill-library.js'

/** Explicit source facts for configuration repository tests; production never manufactures missing owners. */
export async function seedExecutionOwners(database: PlatformDatabase, owners: readonly string[]): Promise<void> {
  const skills = new PostgresSkillLibraryStore(database)
  for (const owner of owners) {
    if (!owner.startsWith('skill:')) throw Error('Fixture requires a skill execution owner')
    const name = owner.slice(6)
    if ((await skills.list()).some(row => row.name === name)) continue
    await skills.save({ name, description: 'Execution owner fixture', hash: 'a'.repeat(64), importedAt: 0, published: false })
  }
}
