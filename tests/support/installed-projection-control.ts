import { randomUUID } from 'node:crypto'
import { readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect } from 'vitest'

/** The installation owner handles only these scoped operations outside the unprivileged probe. */
export async function installedProjectionControl(
  workRoot: string,
  operation:
    | { action: 'configure-git'; proxy: string; caFile: string }
    | { action: 'restore-git' }
    | { action: 'configure-catalog'; address: string }
    | { action: 'rebuild-projections' },
): Promise<void> {
  const id = randomUUID(),
    request = join(workRoot, 'control-request.json')
  await writeFile(request + '.tmp', JSON.stringify({ id, ...operation }), { mode: 0o600 })
  await rename(request + '.tmp', request)
  await expect
    .poll(
      async () => {
        try {
          const response = JSON.parse(await readFile(join(workRoot, 'control-response.json'), 'utf8')) as { id: string; status: string }
          return response.id === id ? response.status : 'pending'
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'pending'
          throw error
        }
      },
      { timeout: 300000, interval: 1000 },
    )
    .not.toBe('pending')
  const response = JSON.parse(await readFile(join(workRoot, 'control-response.json'), 'utf8')) as { id: string; status: string }
  if (response.id !== id || response.status !== 'passed') throw Error('Owned installed control failed: ' + operation.action)
}
