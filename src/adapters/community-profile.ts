import { constants } from 'node:fs'
import { lstat, mkdir, open, rename, rm, writeFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { DSH_PATCH_CONFIG, dshHomePath, dshProfilesPath, dshWebProfilePath } from '../dsh/profile-layout.js'
import { supplyCommunityDefaults } from '../dsh/community-profile.js'

/** Called only after the prior carrier is removed: native DSH cannot race these host operations. */
export async function prepareCommunityProfile(home: string, provider: string, model: string): Promise<void> {
  const directory = dshWebProfilePath(home)
  // User-owned links must never make the host read or create another space's files.
  for (const path of [dshHomePath(home), dshProfilesPath(home), directory]) {
    try { await mkdir(path, { mode: 0o700 }) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
    if (!(await lstat(path)).isDirectory()) throw new Error('Private DSH profile directory is not a directory')
  }
  const path = join(directory, DSH_PATCH_CONFIG)
  let source: string
  try {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      if (!(await file.stat()).isFile()) throw new Error('Private DSH profile patch is not a regular file')
      source = await file.readFile('utf8')
    } finally { await file.close() }
  }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; source = '[]\n' }
  const supplied = supplyCommunityDefaults(source, provider, model)
  if (supplied === source) return
  const staged = `${path}.tmp-${randomBytes(8).toString('hex')}`
  try { await writeFile(staged, supplied, { mode: 0o600, flag: 'wx' }); await rename(staged, path) }
  finally { await rm(staged, { force: true }) }
}
