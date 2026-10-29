import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { expect } from 'vitest'

/** Current installations keep only content, intake and member projections under skills. */
export async function assertSkillArtifactsLayout(dataRoot: string): Promise<void> {
  const allowed = new Set(['artifacts', 'git-intake', 'members'])
  for (const entry of await readdir(join(dataRoot, 'skills'), { withFileTypes: true })) {
    expect(allowed.has(entry.name), 'Unexpected skills carrier: ' + entry.name).toBe(true)
    expect(entry.isDirectory() && !entry.isSymbolicLink(), 'Skills carrier must be a real directory: ' + entry.name).toBe(true)
  }
}
